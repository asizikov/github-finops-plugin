import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { SnapshotStore } from "./cache.mjs";
import { migrateDatabase, migrations, schemaVersion, validateMigrations } from "./migrations.mjs";

const earlySchema = `
    CREATE TABLE snapshots (cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, last_error TEXT);
    CREATE TABLE rate_limits (access_context TEXT PRIMARY KEY, retry_at TEXT NOT NULL);
`;
const relationshipSchema = `
    CREATE TABLE relationship_sources (
        namespace TEXT NOT NULL, snapshot_key TEXT NOT NULL, kind TEXT NOT NULL,
        fetched_at TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (namespace, snapshot_key)
    );
    CREATE TABLE relationship_centers (
        namespace TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, fetched_at TEXT NOT NULL,
        PRIMARY KEY (namespace, id)
    );
    CREATE TABLE relationship_budgets (
        namespace TEXT NOT NULL, id TEXT NOT NULL, scope TEXT NOT NULL, target TEXT,
        payload TEXT NOT NULL, fetched_at TEXT NOT NULL, PRIMARY KEY (namespace, id)
    );
    CREATE TABLE budget_cost_centers (
        namespace TEXT NOT NULL, budget_id TEXT NOT NULL, center_id TEXT NOT NULL,
        matched_by TEXT NOT NULL, PRIMARY KEY (namespace, budget_id)
    );
    CREATE INDEX budgets_by_center ON budget_cost_centers (namespace, center_id);
`;
const date = "2025-01-02T00:00:00Z";
const retryAt = "2025-01-02T00:10:00Z";
const snapshot = JSON.stringify({kind: "budgets", data: [], fetchedAt: date});

function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), "finops-migration-"));
    t.after(() => rmSync(root, {recursive: true}));
    return join(root, "cache.sqlite");
}

function seedEarly(db) {
    db.exec(earlySchema);
    db.prepare("INSERT INTO snapshots VALUES (?, ?, ?)").run("fixture-key", snapshot, "Saved refresh error");
    db.prepare("INSERT INTO rate_limits VALUES (?, ?)").run("fixture-access", retryAt);
}

function rows(db) {
    return Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all()
        .map(({name}) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}

function schema(db) {
    return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name").all();
}

test("fresh initialization is versioned, private, WAL-backed and repeated opens do not rerun DDL", t => {
    const path = fixture(t);
    const store = new SnapshotStore(path);
    let before;
    try {
        assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, schemaVersion);
        assert.equal(store.db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
        assert.equal(store.db.prepare("PRAGMA busy_timeout").get().timeout, 5000);
        assert.equal(statSync(path).mode & 0o777, 0o600);
        store.limit("fixture-access", retryAt);
        before = store.db.prepare("PRAGMA schema_version").get().schema_version;
    } finally { store.close(); }
    const reopened = new SnapshotStore(path);
    try {
        assert.equal(reopened.db.prepare("PRAGMA schema_version").get().schema_version, before);
        assert.equal(reopened.db.prepare("SELECT total_changes() AS count").get().count, 0);
        assert.equal(reopened.deadline("fixture-access", new Date(date)), retryAt);
    } finally { reopened.close(); }
});

test("earliest unversioned snapshots retain exact payload, refresh errors and access-context cooldown", t => {
    const path = fixture(t);
    const db = new DatabaseSync(path);
    seedEarly(db);
    db.close();
    const store = new SnapshotStore(path);
    try {
        assert.deepEqual({...store.db.prepare("SELECT * FROM snapshots").get()}, {
            cache_key: "fixture-key", payload: snapshot, last_error: "Saved refresh error", namespace: null, resource: null,
        });
        assert.equal(store.deadline("fixture-access", new Date(date)), retryAt);
        assert.equal(store.deadline("another-access", new Date(date)), null);
        assert.equal(store.get("fixture-key").lastError, "Saved refresh error");
        assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, schemaVersion);
    } finally { store.close(); }
});

test("intermediate legacy schemas converge, including interrupted additive initialization", async t => {
    for (const extra of [
        relationshipSchema,
        `${relationshipSchema} ALTER TABLE snapshots ADD COLUMN namespace TEXT;`,
        `${relationshipSchema}
            ALTER TABLE snapshots ADD COLUMN namespace TEXT;
            ALTER TABLE snapshots ADD COLUMN resource TEXT;
            CREATE TABLE cache_contexts (namespace TEXT PRIMARY KEY, generation INTEGER NOT NULL);`,
        "CREATE TABLE cache_contexts (namespace TEXT PRIMARY KEY, generation INTEGER NOT NULL);",
    ]) {
        await t.test(extra.includes("ADD COLUMN") ? "classified snapshots" : "unclassified snapshots", t => {
            const path = fixture(t);
            const db = new DatabaseSync(path);
            seedEarly(db);
            db.exec(extra);
            db.close();
            const store = new SnapshotStore(path);
            try {
                assert.equal(store.get("fixture-key").lastError, "Saved refresh error");
                assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, schemaVersion);
                assert.deepEqual(store.relationships("fixture-context").links, []);
            } finally { store.close(); }
        });
    }
});

test("current unversioned cache preserves all rows, provenance, namespaces and generation fences", t => {
    const path = fixture(t);
    const db = new DatabaseSync(path);
    seedEarly(db);
    db.exec(`${relationshipSchema}
        ALTER TABLE snapshots ADD COLUMN namespace TEXT;
        ALTER TABLE snapshots ADD COLUMN resource TEXT;
        CREATE TABLE cache_contexts (namespace TEXT PRIMARY KEY, generation INTEGER NOT NULL);
        CREATE TABLE attribution_revisions (namespace TEXT PRIMARY KEY, revision INTEGER NOT NULL);
        INSERT INTO cache_contexts VALUES ('fixture-context', 7), ('other-context', 2);
        INSERT INTO attribution_revisions VALUES ('fixture-context', 9), ('other-context', 4);
    `);
    const centers = [{id: "fixture-center", name: "Fixture center"}];
    const budgets = [{id: "fixture-budget", scope: "cost_center", entity: "Fixture center"}];
    db.prepare("UPDATE snapshots SET namespace = ?, resource = ?").run("fixture-context", "budgets");
    db.prepare("INSERT INTO snapshots VALUES (?, ?, ?, ?, ?)").run("other-key", snapshot, null, "other-context", "budgets");
    db.prepare("INSERT INTO relationship_sources VALUES (?, ?, ?, ?, ?, ?)").run(
        "fixture-context", "fixture-key", "budgets", date, 5, JSON.stringify(budgets));
    db.prepare("INSERT INTO relationship_sources VALUES (?, ?, ?, ?, ?, ?)").run(
        "fixture-context", "center-key", "cost-centers", date, 3, JSON.stringify(centers));
    db.prepare("INSERT INTO relationship_centers VALUES (?, ?, ?, ?)").run("fixture-context", centers[0].id, centers[0].name, date);
    db.prepare("INSERT INTO relationship_budgets VALUES (?, ?, ?, ?, ?, ?)").run(
        "fixture-context", budgets[0].id, budgets[0].scope, budgets[0].entity, JSON.stringify(budgets[0]), date);
    db.prepare("INSERT INTO budget_cost_centers VALUES (?, ?, ?, ?)").run(
        "fixture-context", budgets[0].id, centers[0].id, "exact_unique_name");
    const before = rows(db);
    db.close();
    const store = new SnapshotStore(path);
    try {
        assert.deepEqual(rows(store.db), before);
        assert.equal(store.generation("fixture-context"), 7);
        assert.equal(store.attributionRevision("fixture-context"), 9);
        assert.equal(store.relationships("fixture-context").links[0].matchedBy, "exact_unique_name");
        assert.deepEqual(store.relationships("other-context").links, []);
        assert.equal(store.deadline("fixture-access", new Date(date)), retryAt);
        assert.throws(() => store.get("fixture-key", "fixture-context", "budgets", 0), error => error.code === "cache_cleared");
        store.clear("fixture-context", 7);
        assert.equal(store.get("other-key", "other-context", "budgets", 2).kind, "budgets");
        assert.equal(store.generation("fixture-context"), 8);
    } finally { store.close(); }
});

test("DDL and version stamps roll back on deliberate SQLite migration failures", async t => {
    for (const failAt of ["CREATE INDEX", "PRAGMA user_version ="]) {
        await t.test(failAt, t => {
            const db = new DatabaseSync(fixture(t));
            try {
                seedEarly(db);
                const beforeSchema = schema(db);
                const beforeRows = rows(db);
                const exec = db.exec.bind(db);
                const mocked = t.mock.method(db, "exec", sql => {
                    if (sql.includes(failAt)) {
                        exec(sql.split("CREATE INDEX")[0]);
                        exec("INSERT INTO deliberately_missing_table VALUES (1)");
                    }
                    return exec(sql);
                });
                assert.throws(() => migrateDatabase(db), /no such table: deliberately_missing_table/);
                mocked.mock.restore();
                assert.equal(db.isTransaction, false);
                assert.equal(db.prepare("PRAGMA user_version").get().user_version, 0);
                assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "delete");
                assert.deepEqual(schema(db), beforeSchema);
                assert.deepEqual(rows(db), beforeRows);
                migrateDatabase(db);
                assert.equal(db.prepare("PRAGMA user_version").get().user_version, schemaVersion);
            } finally { db.close(); }
        });
    }
});

test("future versions fail publicly before changing database bytes, data, schema or journal mode", t => {
    const path = fixture(t);
    const db = new DatabaseSync(path);
    seedEarly(db);
    db.exec(`PRAGMA user_version = ${schemaVersion + 1}; CREATE TABLE future_data (value TEXT);
        INSERT INTO future_data VALUES ('fixture-value');`);
    const beforeSchema = schema(db);
    const beforeRows = rows(db);
    db.close();
    const beforeBytes = readFileSync(path);
    assert.throws(() => new SnapshotStore(path), error => {
        assert.equal(error.code, "local_cache_error");
        assert.match(error.publicMessage, /Update the GitHub FinOps plugin/);
        assert.match(error.publicMessage, new RegExp(`version ${schemaVersion + 1}`));
        return true;
    });
    assert.deepEqual(readFileSync(path), beforeBytes);
    const check = new DatabaseSync(path);
    try {
        assert.deepEqual(schema(check), beforeSchema);
        assert.deepEqual(rows(check), beforeRows);
        assert.equal(check.prepare("PRAGMA user_version").get().user_version, schemaVersion + 1);
        assert.equal(check.prepare("PRAGMA journal_mode").get().journal_mode, "delete");
    } finally { check.close(); }
});

test("incompatible legacy schemas and malformed data are not stamped or repaired silently", async t => {
    for (const sql of [
        "ALTER TABLE snapshots RENAME COLUMN payload TO wrong_payload;",
        "DROP TABLE snapshots; CREATE TABLE snapshots (cache_key TEXT, payload TEXT NOT NULL, last_error TEXT);",
        "ALTER TABLE snapshots ADD COLUMN unexpected TEXT;",
        "DROP TABLE snapshots;",
        "CREATE TABLE unrelated (value TEXT);",
        "DROP INDEX IF EXISTS budgets_by_center; CREATE INDEX budgets_by_center ON snapshots(payload);",
        "UPDATE snapshots SET payload = 'invalid JSON';",
        "INSERT INTO snapshots VALUES (NULL, '{}', NULL);",
        "UPDATE rate_limits SET retry_at = 'invalid date';",
        "CREATE TABLE cache_contexts (namespace TEXT PRIMARY KEY, generation INTEGER NOT NULL); INSERT INTO cache_contexts VALUES ('fixture', 'invalid');",
        `${relationshipSchema} DROP TABLE relationship_sources;
            INSERT INTO relationship_centers VALUES ('fixture', 'fixture-center', 'Fixture center', '${date}');`,
    ]) {
        await t.test(sql, t => {
            const path = fixture(t);
            const db = new DatabaseSync(path);
            seedEarly(db);
            db.exec(sql);
            const beforeSchema = schema(db);
            const beforeRows = rows(db);
            db.close();
            assert.throws(() => new SnapshotStore(path), /incompatible schema/);
            const check = new DatabaseSync(path);
            try {
                assert.equal(check.prepare("PRAGMA user_version").get().user_version, 0);
                assert.deepEqual(schema(check), beforeSchema);
                assert.deepEqual(rows(check), beforeRows);
            } finally { check.close(); }
        });
    }
});

test("an explicitly versioned but incomplete schema is rejected instead of rerunning initialization", t => {
    const path = fixture(t);
    const store = new SnapshotStore(path);
    store.db.exec("DROP TABLE rate_limits");
    store.close();
    assert.throws(() => new SnapshotStore(path), /incompatible schema/);
});

test("migration registry rejects missing, duplicate, out-of-order and invalid versions", () => {
    validateMigrations(migrations);
    for (const versions of [[], [0], [1, 1], [1, 3], [2, 1], [1, 2.5]]) {
        assert.throws(() => validateMigrations(versions.map(version => ({version, sql: "SELECT 1;"}))), /consecutive integer/);
    }
    assert.throws(() => validateMigrations([{version: 1, sql: ""}]), /nonempty SQL/);
});

function worker(path) {
    const script = `
        import {SnapshotStore} from ${JSON.stringify(new URL("./cache.mjs", import.meta.url).href)};
        process.send("ready");
        process.once("message", () => {
            process.send("attempting");
            try {
                const store = new SnapshotStore(${JSON.stringify(path)});
                store.close();
                process.disconnect();
            } catch (error) { console.error(error); process.exit(1); }
        });
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {stdio: ["ignore", "ignore", "pipe", "ipc"]});
    let stderr = "";
    child.stderr.on("data", data => { stderr += data; });
    let ready;
    let attempting;
    const started = new Promise(resolve => { ready = resolve; });
    const locked = new Promise(resolve => { attempting = resolve; });
    child.on("message", message => {
        if (message === "ready") ready();
        if (message === "attempting") attempting();
    });
    const exited = new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", code => code === 0 ? resolve() : reject(new Error(`Worker exited ${code}: ${stderr}`)));
    });
    return {child, started, locked, exited};
}

test("concurrent processes serialize fresh initialization and legacy upgrades behind a held write lock", {timeout: 20000}, async t => {
    for (const legacy of [false, true]) {
        await t.test(legacy ? "legacy upgrade" : "fresh database", async t => {
            const path = fixture(t);
            const db = new DatabaseSync(path);
            if (legacy) seedEarly(db);
            db.exec("BEGIN IMMEDIATE");
            const workers = Array.from({length: 3}, () => worker(path));
            try {
                await Promise.all(workers.map(worker => worker.started));
                for (const {child} of workers) child.send("start");
                await Promise.all(workers.map(worker => worker.locked));
                await new Promise(resolve => setTimeout(resolve, 50));
                db.exec("COMMIT");
                await Promise.all(workers.map(worker => worker.exited));
                assert.equal(db.prepare("PRAGMA user_version").get().user_version, schemaVersion);
                assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
                if (legacy) assert.equal(db.prepare("SELECT payload FROM snapshots").get().payload, snapshot);
            } finally {
                if (db.isTransaction) db.exec("ROLLBACK");
                db.close();
                for (const {child} of workers) {
                    if (child.exitCode === null) child.kill();
                }
            }
        });
    }
});
