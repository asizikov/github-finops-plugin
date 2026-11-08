import { DatabaseSync } from "node:sqlite";
import { mkdirSync, openSync, closeSync, chmodSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { loadOverview, validateInput } from "./budgets.mjs";
import { ghRead, localAccessContext, GitHubReadError } from "./github.mjs";
import { loadCostCenters, validateCenterId } from "./cost-centers.mjs";
import { loadBudgets, validateBudgetId } from "./budget-list.mjs";
import { indexRelationships, readRelationships } from "./relationships.mjs";
import { migrateDatabase, CacheSchemaError } from "./migrations.mjs";
import {loadUser} from "./users.mjs";
import {normalizeUsername} from "./ui/user-format.mjs";
import {loadTeamCostCenters, validateTeamSlug} from "./enterprise-teams.mjs";
import {loadConnection} from "./settings.mjs";
import {loadUniversalUsers} from "./universal-users.mjs";

const configurationResources = ["cost-centers", "cost-center-detail", "budgets", "budget-detail", "user", "team-cost-centers", "connection", "universal-users"];

class CacheClearedError extends Error {
    constructor() {
        super("This cache was cleared while a request was in progress. Reload before requesting data again.");
        this.publicMessage = this.message;
        this.code = "cache_cleared";
    }
}

class LocalCacheError extends Error {
    constructor(cause) {
        super(cause instanceof CacheSchemaError ? cause.publicMessage :
            "Could not access the local SQLite cache. Check cache permissions and database integrity; close FinOps canvases and back up the cache with its WAL/SHM files before repair.", { cause });
        this.publicMessage = this.message;
        this.code = "local_cache_error";
    }
}

export class SnapshotStore {
    constructor(path) {
        try {
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
            closeSync(openSync(path, "a", 0o600));
            chmodSync(path, 0o600);
            this.db = new DatabaseSync(path);
            migrateDatabase(this.db);
        } catch (error) {
            this.db?.close();
            throw new LocalCacheError(error);
        }
    }

    operation(fn) {
        try { return fn(); } catch (error) {
            if (error instanceof CacheClearedError) throw error;
            throw new LocalCacheError(error);
        }
    }

    generation(namespace) {
        return this.operation(() => this.db.prepare("SELECT generation FROM cache_contexts WHERE namespace = ?").get(namespace)?.generation ?? 0);
    }

    assertCurrent(namespace, generation) {
        if (namespace && this.generation(namespace) !== generation) throw new CacheClearedError();
    }

    get(key, namespace, resource, generation) {
        return this.operation(() => {
            this.assertCurrent(namespace, generation);
            const row = this.db.prepare("SELECT payload, last_error, namespace, resource FROM snapshots WHERE cache_key = ?").get(key);
            if (!row) return null;
            const snapshot = JSON.parse(row.payload);
            if (snapshot.kind) {
                if (!configurationResources.includes(snapshot.kind) ||
                    !Number.isFinite(Date.parse(snapshot.fetchedAt)) || snapshot.data == null) {
                    throw new Error("Invalid cached configuration.");
                }
            } else if (!Array.isArray(snapshot.budgets) || !Number.isFinite(Date.parse(snapshot.budgetsAt)) ||
                (snapshot.spendingAt !== null && !Number.isFinite(Date.parse(snapshot.spendingAt))) ||
                !["available", "unavailable", "error"].includes(snapshot.spending?.status)) {
                throw new Error("Invalid cached snapshot.");
            }
            if (namespace && (row.namespace !== namespace || row.resource !== resource)) {
                this.db.prepare("UPDATE snapshots SET namespace = ?, resource = ? WHERE cache_key = ?").run(namespace, resource, key);
            }
            return { ...snapshot, lastError: row.last_error };
        });
    }

    transaction(fn) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const result = fn();
            this.db.exec("COMMIT");
            return result;
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }

    put(key, snapshot, error = null, namespace, generation = namespace ? this.generation(namespace) : undefined, attributionRevision) {
        this.operation(() => this.transaction(() => {
            this.assertCurrent(namespace, generation);
            if (snapshot.kind === "user" && attributionRevision !== undefined &&
                this.attributionRevision(namespace) !== attributionRevision) {
                const previous = this.get(key)?.data;
                invalidateAttribution(snapshot.data.attribution, new Date().toISOString());
                snapshot.data.attribution.lastConfirmed = previous?.id === snapshot.data.id
                    ? confirmedReference(previous.attribution) : null;
            }
            this.db.prepare(`
                INSERT INTO snapshots (cache_key, payload, last_error, namespace, resource) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, last_error = excluded.last_error,
                    namespace = excluded.namespace, resource = excluded.resource
            `).run(key, JSON.stringify(snapshot), error, namespace ?? null, snapshot.kind ?? "overview");
            if (namespace) indexRelationships(this.db, namespace, key, snapshot);
        }));
    }

    index(namespace, key, snapshot, generation = this.generation(namespace)) {
        this.operation(() => this.transaction(() => {
            this.assertCurrent(namespace, generation);
            indexRelationships(this.db, namespace, key, snapshot);
        }));
    }

    relationships(namespace) { return this.operation(() => readRelationships(this.db, namespace)); }

    attributionRevision(namespace) {
        return this.operation(() => this.db.prepare("SELECT revision FROM attribution_revisions WHERE namespace = ?")
            .get(namespace)?.revision ?? 0);
    }

    invalidateAttributions(namespace, generation, checkedAt) {
        this.operation(() => this.transaction(() => {
            this.assertCurrent(namespace, generation);
            this.db.prepare(`INSERT INTO attribution_revisions VALUES (?, 1)
                ON CONFLICT(namespace) DO UPDATE SET revision = revision + 1`).run(namespace);
            for (const row of this.db.prepare("SELECT cache_key, payload FROM snapshots WHERE namespace = ? AND resource = 'user'").all(namespace)) {
                const snapshot = JSON.parse(row.payload);
                const attribution = snapshot.data.attribution;
                if (!attribution) continue;
                invalidateAttribution(attribution, checkedAt);
                this.db.prepare("UPDATE snapshots SET payload = ? WHERE cache_key = ?")
                    .run(JSON.stringify(snapshot), row.cache_key);
            }
        }));
    }

    fail(key, message, namespace, generation) {
        this.operation(() => this.transaction(() => {
            this.assertCurrent(namespace, generation);
            this.db.prepare("UPDATE snapshots SET last_error = ? WHERE cache_key = ?").run(message, key);
        }));
    }

    inventory(namespace) {
        return this.operation(() => {
            const groups = new Map();
            for (const row of this.db.prepare("SELECT resource, payload, last_error FROM snapshots WHERE namespace = ?").all(namespace)) {
                const snapshot = JSON.parse(row.payload);
                const dates = [[row.resource, snapshot.fetchedAt ?? snapshot.budgetsAt]];
                if (!snapshot.kind && snapshot.spendingAt) dates.push(["overview-spending", snapshot.spendingAt]);
                for (const [resource, date] of dates) {
                    const group = groups.get(resource) ?? {resource, count: 0, oldestAt: date, newestAt: date, errors: 0};
                    group.count++;
                    if (date < group.oldestAt) group.oldestAt = date;
                    if (date > group.newestAt) group.newestAt = date;
                    if (row.last_error) group.errors++;
                    groups.set(resource, group);
                }
            }
            return [...groups.values()].sort((a, b) => a.resource.localeCompare(b.resource));
        });
    }

    clear(namespace, generation) {
        this.operation(() => this.transaction(() => {
            this.assertCurrent(namespace, generation);
            this.db.prepare(`INSERT INTO cache_contexts VALUES (?, ?) ON CONFLICT(namespace)
                DO UPDATE SET generation = excluded.generation`).run(namespace, generation + 1);
            this.db.prepare("DELETE FROM snapshots WHERE namespace = ?").run(namespace);
            this.db.prepare("DELETE FROM attribution_revisions WHERE namespace = ?").run(namespace);
            for (const table of ["relationship_sources", "relationship_centers", "relationship_budgets", "budget_cost_centers"]) {
                this.db.prepare(`DELETE FROM ${table} WHERE namespace = ?`).run(namespace);
            }
        }));
    }

    deadline(context, now) {
        return this.operation(() => {
            const row = this.db.prepare("SELECT retry_at FROM rate_limits WHERE access_context = ?").get(context);
            if (!row) return null;
            const deadline = Date.parse(row.retry_at);
            if (!Number.isFinite(deadline)) throw new Error("Invalid cached rate-limit deadline.");
            return deadline > now.getTime() ? row.retry_at : null;
        });
    }

    limit(context, retryAt) {
        this.operation(() => this.db.prepare(`
            INSERT INTO rate_limits (access_context, retry_at) VALUES (?, ?)
            ON CONFLICT(access_context) DO UPDATE SET retry_at = MAX(retry_at, excluded.retry_at)
        `).run(context, retryAt));
    }

    close() { this.operation(() => this.db.close()); }
}

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class OverviewCache {
    constructor(store, { identity = localAccessContext, load = loadOverview, read = ghRead, clock = () => new Date() } = {}) {
        this.store = store;
        this.identity = identity;
        this.load = load;
        this.read = read;
        this.clock = clock;
        this.pending = new Map();
    }

    async scope(input) {
        const config = validateInput(input);
        const context = digest([config.host.toLowerCase(), await this.identity(config.host)]);
        const namespace = digest([config.host.toLowerCase(), config.enterprise.toLowerCase(), context]);
        const generation = this.store.generation(namespace);
        return {config, context, namespace, generation, contextToken: digest([namespace, generation])};
    }

    async status(input) {
        const {context, namespace, generation, contextToken} = await this.scope(input);
        return {exists: true, contextToken, snapshots: this.store.inventory(namespace),
            retryAt: this.store.deadline(context, this.clock()),
            refreshing: [...this.pending.keys()].some(key => key.startsWith(`${namespace}:${generation}:`))};
    }

    async clear(input, contextToken) {
        const scope = await this.scope(input);
        if (!contextToken || contextToken !== scope.contextToken) {
            const error = new Error("The enterprise/account cache context changed. Reload cache status and confirm again.");
            error.publicMessage = error.message;
            throw error;
        }
        this.store.clear(scope.namespace, scope.generation);
        return {cleared: true};
    }

    present(snapshot, source, retryAt = null, error = snapshot.lastError ?? null, namespace) {
        if (snapshot.kind) {
            return { data: snapshot.data, relationships: this.store.relationships(namespace), cache: {
                source, stale: source === "cached" || Boolean(error),
                fetchedAt: snapshot.fetchedAt, error, retryAt,
            } };
        }
        return {
            budgets: snapshot.budgets,
            spending: snapshot.spending,
            updatedAt: snapshot.budgetsAt,
            cache: {
                source, stale: source === "cached" || Boolean(error),
                budgetsAt: snapshot.budgetsAt, spendingAt: snapshot.spendingAt,
                error, retryAt,
            },
        };
    }

    async get(input, { refresh = false, resource = "overview", id, cacheOnly = false } = {}) {
        if (resource !== "overview" && !configurationResources.includes(resource)) throw new Error("Invalid cache resource.");
        if (resource === "cost-center-detail") validateCenterId(id);
        if (resource === "budget-detail") validateBudgetId(id);
        if (resource === "user") id = normalizeUsername(id);
        if (resource === "team-cost-centers") validateTeamSlug(id);
        const {config, context, namespace, generation} = await this.scope(input);
        const cacheKey = scope => {
            const original = digest([config.host.toLowerCase(), config.enterprise.toLowerCase(), context, ...scope]);
            return generation === 0 ? original : digest([original, generation]);
        };
        const now = this.clock();
        const scope = resource === "overview"
            ? [now.getUTCFullYear(), now.getUTCMonth() + 1] : [resource, id ?? null];
        if (resource === "budgets" || resource === "budget-detail" || resource === "user" || resource === "universal-users") {
            scope.push(now.getUTCFullYear(), now.getUTCMonth() + 1);
        }
        const key = cacheKey(scope);
        if (resource !== "overview") {
            for (const listScope of [["cost-centers", null], ["budgets", null, now.getUTCFullYear(), now.getUTCMonth() + 1]]) {
                const listKey = cacheKey(listScope);
                this.store.index(namespace, listKey, this.store.get(listKey, namespace, listScope[0], generation), generation);
            }
        }
        const cached = this.store.get(key, namespace, resource, generation);
        if (resource !== "overview" && cached) this.store.index(namespace, key, cached, generation);
        const retryAt = this.store.deadline(context, now);
        if (retryAt) {
            const message = "GitHub requests are paused until the rate-limit cooldown ends. Cached data has not been refreshed.";
            if (cached) return this.present(cached, "cached", retryAt, message, namespace);
            throw new GitHubReadError(`${message} No snapshot is available for this account${resource === "overview" ? " and billing month" : ""}.`, retryAt);
        }
        if (cacheOnly && !cached) return null;
        if (!refresh && cached) return this.present(cached, "cached", null, undefined, namespace);
        const pendingKey = `${namespace}:${generation}:${key}`;
        let pending = this.pending.get(pendingKey);
        if (!pending) {
            pending = this.refresh(key, config, context, cached, now, resource, id, namespace, generation);
            this.pending.set(pendingKey, pending);
            pending.then(() => this.pending.delete(pendingKey), () => this.pending.delete(pendingKey));
        }
        return pending;
    }

    async refresh(key, config, context, cached, now, resource, id, namespace, generation) {
        const attributionRevision = resource === "user" ? this.store.attributionRevision(namespace) : null;
        const read = async (path, host, inspect, identity) => {
            this.store.assertCurrent(namespace, generation);
            const blocked = this.store.deadline(context, this.clock());
            if (blocked) throw new GitHubReadError("GitHub rate-limit cooldown is active.", blocked);
            try {
                const result = await this.read(path, host, retryAt => this.store.limit(context, retryAt), inspect, identity);
                this.store.assertCurrent(namespace, generation);
                return result;
            } catch (error) {
                if (error.retryAt) this.store.limit(context, error.retryAt);
                throw error;
            }
        };
        let live;
        try {
            live = resource === "overview" ? await this.load(config, read, now)
                : resource === "universal-users" ? await loadUniversalUsers(config, read, now)
                : resource === "user" ? await loadUser(config, read, id, now)
                : resource === "team-cost-centers" ? await loadTeamCostCenters(config, read, id)
                : resource === "connection" ? await loadConnection(config, read, now)
                : resource === "budgets" || resource === "budget-detail"
                    ? await loadBudgets(config, read, resource === "budget-detail" ? id : undefined)
                    : await loadCostCenters(config, read, resource === "cost-center-detail" ? id : undefined);
        } catch (error) {
            this.store.assertCurrent(namespace, generation);
            if (error instanceof LocalCacheError || error instanceof CacheClearedError) throw error;
            console.error("Live data refresh failed:", error);
            if (error.retryAt) this.store.limit(context, error.retryAt);
            const retained = this.store.get(key) ?? cached;
            if (!retained) throw error;
            const message = error.publicMessage ?? "Live refresh failed. The last successful snapshot is shown.";
            this.store.fail(key, message, namespace, generation);
            return this.present(retained, "cached", this.store.deadline(context, this.clock()), message, namespace);
        }
        this.store.assertCurrent(namespace, generation);
        if (resource !== "overview") {
            if (resource === "connection") {
                const retained = (this.store.get(key) ?? cached)?.data;
                live.checks = live.checks.map(check => ({...check,
                    lastAccessibleAt: check.state === "accessible" ? live.checkedAt :
                        retained?.checks.find(previous => previous.key === check.key)?.lastAccessibleAt ?? null}));
                for (const field of ["name", "login"]) {
                    if (live[field] === null && retained?.[field]) {
                        live[field] = retained[field];
                        live[`${field}At`] = retained[`${field}At`];
                    }
                }
            }
            if (resource === "user" && live.enterpriseTeams.error) {
                const retainedUser = (this.store.get(key) ?? cached)?.data;
                const retained = retainedUser?.id === live.id ? retainedUser.enterpriseTeams : null;
                if (retained?.items != null) {
                    live.enterpriseTeams = {...live.enterpriseTeams, items: retained.items, fetchedAt: retained.fetchedAt};
                }
            }
            if (resource === "user" && live.spending?.status === "error") {
                const retainedUser = (this.store.get(key) ?? cached)?.data;
                const previous = retainedUser?.id === live.id ? retainedUser.spending : null;
                if (previous && previous.status !== "error" && previous.period?.year === live.spending.period.year &&
                    previous.period?.month === live.spending.period.month) {
                    live.spending = {...previous, retainedAfterError: live.spending.message};
                }
            }
            if (resource === "user" && live.attribution.status !== "confirmed") {
                const retainedUser = (this.store.get(key) ?? cached)?.data;
                const previous = retainedUser?.id === live.id ? retainedUser.attribution : null;
                live.attribution.lastConfirmed = confirmedReference(previous);
            }
            const snapshot = { kind: resource, data: live, fetchedAt: new Date().toISOString(),
                ...(["cost-centers", "budgets"].includes(resource) ? {complete: true} : {}),
            };
            this.store.put(key, snapshot, null, namespace, generation, resource === "user" ? attributionRevision : undefined);
            if (["cost-centers", "cost-center-detail", "team-cost-centers"].includes(resource)) {
                this.store.invalidateAttributions(namespace, generation, snapshot.fetchedAt);
            }
            return this.present(snapshot, "live", this.store.deadline(context, this.clock()), undefined, namespace);
        }
        const spendingFailed = live.spending.status === "error";
        const retained = this.store.get(key) ?? cached;
        const spending = spendingFailed ? retained?.spending ?? live.spending : live.spending;
        const snapshot = {
            budgets: live.budgets, budgetsAt: live.updatedAt,
            spending, spendingAt: spendingFailed ? retained?.spendingAt ?? null : live.updatedAt,
        };
        const error = spendingFailed ? live.spending.message : null;
        if (live.spending.retryAt) this.store.limit(context, live.spending.retryAt);
        this.store.put(key, snapshot, error, namespace, generation);
        return this.present(snapshot, "live",
            this.store.deadline(context, this.clock()), error);
    }
}

function invalidateAttribution(attribution, checkedAt) {
    attribution.lastConfirmed = confirmedReference(attribution);
    attribution.status = attribution.center ? "provisional" : "unresolved";
    attribution.invalidatedAt = checkedAt;
    attribution.reason = "Related cost center or team configuration was refreshed. Refresh this user to recheck all attribution evidence.";
    attribution.unresolved = [attribution.reason];
}

function confirmedReference(attribution) {
    return attribution?.status === "confirmed"
        ? {center: attribution.center, method: attribution.method, checkedAt: attribution.checkedAt}
        : attribution?.lastConfirmed ?? null;
}

let cache;
export function databasePath() {
    const root = process.env.GITHUB_FINOPS_CACHE_DIR ?? join(
        process.env.COPILOT_HOME ?? join(homedir(), ".copilot"),
        "extensions", "github-finops", "artifacts",
    );
    return resolve(root, "cache.sqlite");
}
export function cachedOverview(input, options) {
    if (options?.cacheOnly && !cache && !existsSync(databasePath())) return Promise.resolve(null);
    if (!cache) {
        cache = new OverviewCache(new SnapshotStore(databasePath()));
    }
    return cache.get(input, options);
}

export async function cacheControls(input, {action = "status", contextToken} = {}) {
    if (!cache && !existsSync(databasePath())) {
        if (action !== "status") throw new Error("No database exists. Reload cache status.");
        return {exists: false, contextToken: null, snapshots: [], refreshing: false, retryAt: null};
    }
    if (!cache) cache = new OverviewCache(new SnapshotStore(databasePath()));
    if (action === "status") return cache.status(input);
    if (action === "clear") return cache.clear(input, contextToken);
    throw new Error("Invalid cache action.");
}
