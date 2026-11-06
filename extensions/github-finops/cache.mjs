import { DatabaseSync } from "node:sqlite";
import { mkdirSync, openSync, closeSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { loadOverview, validateInput } from "./budgets.mjs";
import { ghRead, localAccessContext, GitHubReadError } from "./github.mjs";
import { loadCostCenters, validateCenterId } from "./cost-centers.mjs";
import { loadBudgets, validateBudgetId } from "./budget-list.mjs";
import { relationshipSchema, indexRelationships, readRelationships } from "./relationships.mjs";
import {loadUser} from "./users.mjs";
import {normalizeUsername} from "./ui/user-format.mjs";
import {loadTeamCostCenters, validateTeamSlug} from "./enterprise-teams.mjs";

const configurationResources = ["cost-centers", "cost-center-detail", "budgets", "budget-detail", "user", "team-cost-centers"];

class LocalCacheError extends Error {
    constructor(cause) {
        super("Could not access the local SQLite cache. Check cache permissions and database integrity.", { cause });
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
            this.db.exec(`
                PRAGMA busy_timeout = 5000;
                PRAGMA journal_mode = WAL;
                CREATE TABLE IF NOT EXISTS snapshots (
                    cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL,
                    last_error TEXT
                );
                CREATE TABLE IF NOT EXISTS rate_limits (
                    access_context TEXT PRIMARY KEY, retry_at TEXT NOT NULL
                );
            `);
            this.db.exec(relationshipSchema);
        } catch (error) {
            this.db?.close();
            throw new LocalCacheError(error);
        }
    }

    operation(fn) {
        try { return fn(); } catch (error) { throw new LocalCacheError(error); }
    }

    get(key) {
        return this.operation(() => {
            const row = this.db.prepare("SELECT payload, last_error FROM snapshots WHERE cache_key = ?").get(key);
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

    put(key, snapshot, error = null, namespace) {
        this.operation(() => this.transaction(() => {
            this.db.prepare(`
                INSERT INTO snapshots (cache_key, payload, last_error) VALUES (?, ?, ?)
                ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, last_error = excluded.last_error
            `).run(key, JSON.stringify(snapshot), error);
            if (namespace) indexRelationships(this.db, namespace, key, snapshot);
        }));
    }

    index(namespace, key, snapshot) {
        this.operation(() => this.transaction(() => indexRelationships(this.db, namespace, key, snapshot)));
    }

    relationships(namespace) { return this.operation(() => readRelationships(this.db, namespace)); }

    fail(key, message) {
        this.operation(() => this.db.prepare("UPDATE snapshots SET last_error = ? WHERE cache_key = ?").run(message, key));
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

    async get(input, { refresh = false, resource = "overview", id } = {}) {
        if (resource !== "overview" && !configurationResources.includes(resource)) throw new Error("Invalid cache resource.");
        if (resource === "cost-center-detail") validateCenterId(id);
        if (resource === "budget-detail") validateBudgetId(id);
        if (resource === "user") id = normalizeUsername(id);
        if (resource === "team-cost-centers") validateTeamSlug(id);
        const config = validateInput(input);
        const context = digest([config.host.toLowerCase(), await this.identity(config.host)]);
        const namespace = digest([config.host.toLowerCase(), config.enterprise.toLowerCase(), context]);
        const now = this.clock();
        const scope = resource === "overview"
            ? [now.getUTCFullYear(), now.getUTCMonth() + 1] : [resource, id ?? null];
        if (resource === "budgets" || resource === "budget-detail" || resource === "user") {
            scope.push(now.getUTCFullYear(), now.getUTCMonth() + 1);
        }
        const key = digest([config.host.toLowerCase(), config.enterprise.toLowerCase(), context, ...scope]);
        if (resource !== "overview") {
            for (const listScope of [["cost-centers", null], ["budgets", null, now.getUTCFullYear(), now.getUTCMonth() + 1]]) {
                const listKey = digest([config.host.toLowerCase(), config.enterprise.toLowerCase(), context, ...listScope]);
                this.store.index(namespace, listKey, this.store.get(listKey));
            }
        }
        const cached = this.store.get(key);
        if (resource !== "overview" && cached) this.store.index(namespace, key, cached);
        const retryAt = this.store.deadline(context, now);
        if (retryAt) {
            const message = "GitHub requests are paused until the rate-limit cooldown ends. Cached data has not been refreshed.";
            if (cached) return this.present(cached, "cached", retryAt, message, namespace);
            throw new GitHubReadError(`${message} No snapshot is available for this account${resource === "overview" ? " and billing month" : ""}.`, retryAt);
        }
        if (!refresh && cached) return this.present(cached, "cached", null, undefined, namespace);
        let pending = this.pending.get(key);
        if (!pending) {
            pending = this.refresh(key, config, context, cached, now, resource, id, namespace);
            this.pending.set(key, pending);
            pending.then(() => this.pending.delete(key), () => this.pending.delete(key));
        }
        return pending;
    }

    async refresh(key, config, context, cached, now, resource, id, namespace) {
        const read = async (path, host) => {
            const blocked = this.store.deadline(context, this.clock());
            if (blocked) throw new GitHubReadError("GitHub rate-limit cooldown is active.", blocked);
            try {
                return await this.read(path, host, retryAt => this.store.limit(context, retryAt));
            } catch (error) {
                if (error.retryAt) this.store.limit(context, error.retryAt);
                throw error;
            }
        };
        let live;
        try {
            live = resource === "overview" ? await this.load(config, read, now)
                : resource === "user" ? await loadUser(config, read, id, now)
                : resource === "team-cost-centers" ? await loadTeamCostCenters(config, read, id)
                : resource === "budgets" || resource === "budget-detail"
                    ? await loadBudgets(config, read, resource === "budget-detail" ? id : undefined)
                    : await loadCostCenters(config, read, resource === "cost-center-detail" ? id : undefined);
        } catch (error) {
            if (error instanceof LocalCacheError) throw error;
            console.error("Live data refresh failed:", error);
            if (error.retryAt) this.store.limit(context, error.retryAt);
            const retained = this.store.get(key) ?? cached;
            if (!retained) throw error;
            const message = error.publicMessage ?? "Live refresh failed. The last successful snapshot is shown.";
            this.store.fail(key, message);
            return this.present(retained, "cached", this.store.deadline(context, this.clock()), message, namespace);
        }
        if (resource !== "overview") {
            if (resource === "user" && live.enterpriseTeams.error) {
                const retainedUser = (this.store.get(key) ?? cached)?.data;
                const retained = retainedUser?.id === live.id ? retainedUser.enterpriseTeams : null;
                if (retained?.items != null) {
                    live.enterpriseTeams = {...live.enterpriseTeams, items: retained.items, fetchedAt: retained.fetchedAt};
                }
            }
            const snapshot = { kind: resource, data: live, fetchedAt: new Date().toISOString(),
                ...(["cost-centers", "budgets"].includes(resource) ? {complete: true} : {}),
            };
            this.store.put(key, snapshot, null, namespace);
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
        this.store.put(key, snapshot, error);
        return this.present(snapshot, "live",
            this.store.deadline(context, this.clock()), error);
    }
}

let cache;
export function cachedOverview(input, options) {
    if (!cache) {
        const root = process.env.GITHUB_FINOPS_CACHE_DIR ?? join(
            process.env.COPILOT_HOME ?? join(homedir(), ".copilot"),
            "extensions", "github-finops", "artifacts",
        );
        cache = new OverviewCache(new SnapshotStore(join(root, "cache.sqlite")));
    }
    return cache.get(input, options);
}
