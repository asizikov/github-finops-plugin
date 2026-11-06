import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

// Published migrations are immutable; append the next consecutive integer.
export const migrations = Object.freeze([
    Object.freeze({version: 1, sql: `
        CREATE TABLE IF NOT EXISTS snapshots (
            cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL,
            last_error TEXT, namespace TEXT, resource TEXT
        );
        CREATE TABLE IF NOT EXISTS cache_contexts (
            namespace TEXT PRIMARY KEY, generation INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS rate_limits (
            access_context TEXT PRIMARY KEY, retry_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS attribution_revisions (
            namespace TEXT PRIMARY KEY, revision INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS relationship_sources (
            namespace TEXT NOT NULL, snapshot_key TEXT NOT NULL, kind TEXT NOT NULL,
            fetched_at TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL,
            PRIMARY KEY (namespace, snapshot_key)
        );
        CREATE TABLE IF NOT EXISTS relationship_centers (
            namespace TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, fetched_at TEXT NOT NULL,
            PRIMARY KEY (namespace, id)
        );
        CREATE TABLE IF NOT EXISTS relationship_budgets (
            namespace TEXT NOT NULL, id TEXT NOT NULL, scope TEXT NOT NULL, target TEXT,
            payload TEXT NOT NULL, fetched_at TEXT NOT NULL, PRIMARY KEY (namespace, id)
        );
        CREATE TABLE IF NOT EXISTS budget_cost_centers (
            namespace TEXT NOT NULL, budget_id TEXT NOT NULL, center_id TEXT NOT NULL,
            matched_by TEXT NOT NULL, PRIMARY KEY (namespace, budget_id)
        );
        CREATE INDEX IF NOT EXISTS budgets_by_center ON budget_cost_centers (namespace, center_id);
    `}),
]);

export function validateMigrations(steps) {
    if (!steps.length || steps.some((step, index) => step.version !== index + 1 ||
        typeof step.sql !== "string" || !step.sql.trim())) {
        throw new Error("Cache migrations must have consecutive integer versions starting at 1 and nonempty SQL.");
    }
}

validateMigrations(migrations);
export const schemaVersion = migrations.at(-1).version;

export class CacheSchemaError extends Error {
    constructor(message) {
        super(message);
        this.publicMessage = message;
    }
}

function incompatible(detail) {
    throw new CacheSchemaError(`The local SQLite cache has an incompatible schema (${detail}). ` +
        "Close the FinOps canvases and back up the cache with its WAL/SHM files before investigating or restoring a compatible backup. The cache was not reset.");
}

const quote = name => `"${name.replaceAll('"', '""')}"`;
const tables = db => db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name")
    .all().map(row => row.name);
const columns = (db, table) => db.prepare(`PRAGMA table_xinfo(${quote(table)})`).all().map(row => ({...row}));

function indexes(db, table) {
    return db.prepare(`PRAGMA index_list(${quote(table)})`).all().map(({name, unique, origin, partial}) => ({
        name, unique, origin, partial, columns: db.prepare(`PRAGMA index_xinfo(${quote(name)})`).all(),
    })).sort((a, b) => a.name.localeCompare(b.name));
}

function validateSchema(db, expected, legacy) {
    const expectedTables = tables(expected);
    const actualTables = tables(db);
    if (actualTables.some(table => !expectedTables.includes(table)) ||
        (!legacy && !isDeepStrictEqual(actualTables, expectedTables))) incompatible("unexpected or missing tables");
    if (actualTables.length && !actualTables.includes("snapshots")) incompatible("missing snapshots");
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type IN ('view', 'trigger') LIMIT 1").get()) {
        incompatible("unexpected views or triggers");
    }
    const relationshipTables = expectedTables.filter(table => table.startsWith("relationship_") || table === "budget_cost_centers");
    if (legacy && relationshipTables.some(table => !actualTables.includes(table)) &&
        relationshipTables.some(table => actualTables.includes(table) &&
            db.prepare(`SELECT 1 FROM ${quote(table)} LIMIT 1`).get())) {
        incompatible("incomplete relationship provenance");
    }
    for (const table of actualTables) {
        const actualColumns = columns(db, table);
        let expectedColumns = columns(expected, table);
        if (legacy && table === "snapshots") {
            expectedColumns = expectedColumns.filter(column => !["namespace", "resource"].includes(column.name) ||
                actualColumns.some(actual => actual.name === column.name));
            expectedColumns = expectedColumns.map((column, cid) => ({...column, cid}));
        }
        if (!isDeepStrictEqual(actualColumns, expectedColumns)) incompatible(`table ${table}`);
        const actualIndexes = indexes(db, table);
        const expectedIndexes = indexes(expected, table).filter(index => !legacy || index.origin !== "c" ||
            actualIndexes.some(actual => actual.name === index.name));
        if (!isDeepStrictEqual(actualIndexes, expectedIndexes)) incompatible(`indexes on ${table}`);
        if (!isDeepStrictEqual(db.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all(),
            expected.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all())) incompatible(`foreign keys on ${table}`);
        if (legacy) validateLegacyData(db, table, actualColumns);
    }
}

function validateLegacyData(db, table, tableColumns) {
    const invalid = tableColumns.map(column => {
        const name = quote(column.name);
        const type = column.type.toLowerCase();
        return `((${name} IS NULL AND ${column.notnull || column.pk ? 1 : 0}) OR ` +
            `(${name} IS NOT NULL AND typeof(${name}) != '${type}'))`;
    });
    if (tableColumns.some(column => column.name === "payload")) invalid.push("NOT json_valid(payload)");
    for (const column of ["generation", "revision"]) {
        if (tableColumns.some(item => item.name === column)) invalid.push(`${quote(column)} < 0`);
    }
    if (db.prepare(`SELECT 1 FROM ${quote(table)} WHERE ${invalid.join(" OR ")} LIMIT 1`).get()) {
        incompatible(`invalid data in ${table}`);
    }
    for (const column of ["retry_at", "fetched_at"]) {
        if (!tableColumns.some(item => item.name === column)) continue;
        for (const row of db.prepare(`SELECT DISTINCT ${quote(column)} AS value FROM ${quote(table)}`).iterate()) {
            if (!Number.isFinite(Date.parse(row.value))) incompatible(`invalid ${column} in ${table}`);
        }
    }
}

export function migrateDatabase(db) {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    let expected;
    try {
        // Read only after taking the write lock: another process may just have migrated.
        const version = db.prepare("PRAGMA user_version").get().user_version;
        if (version > schemaVersion) {
            throw new CacheSchemaError(`The local SQLite cache uses schema version ${version}, but this plugin supports ${schemaVersion}. ` +
                "Update the GitHub FinOps plugin before opening this cache. The cache was not downgraded or reset.");
        }
        if (version < 0) incompatible("invalid schema version");
        expected = new DatabaseSync(":memory:");
        // Version zero predates explicit migrations; validate any existing additive schema.
        for (const step of migrations) {
            if (step.version <= Math.max(version, 1)) expected.exec(step.sql);
        }
        validateSchema(db, expected, version === 0);
        if (version === 0) {
            const existing = columns(db, "snapshots");
            if (existing.length) {
                for (const column of ["namespace", "resource"]) {
                    if (!existing.some(item => item.name === column)) db.exec(`ALTER TABLE snapshots ADD COLUMN ${column} TEXT`);
                }
            }
        }
        for (const step of migrations) {
            if (step.version <= version) continue;
            db.exec(step.sql);
            db.exec(`PRAGMA user_version = ${step.version}`);
        }
        for (const step of migrations) {
            if (step.version > Math.max(version, 1)) expected.exec(step.sql);
        }
        validateSchema(db, expected, false);
        db.exec("COMMIT");
    } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
    } finally {
        expected?.close();
    }
    // journal_mode cannot change inside a transaction, and must not change a future cache.
    db.exec("PRAGMA journal_mode = WAL");
}
