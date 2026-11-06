import {test} from "node:test";
import assert from "node:assert/strict";
import {buildAttentionQueue, expirationDays, mergeAttentionBudgets, paginateAttention} from "./attention.mjs";

const now = "2026-11-06T22:30:00Z";
const budget = (fields = {}) => ({id: "budget-one", scope: "enterprise", type: "ProductPricing",
    product: "actions", amount: 100, consumed: 0, preventFurtherUsage: true, alerts: true, ...fields});
const reasons = fields => buildAttentionQueue([budget(fields)], now).rows[0]?.reasons.map(reason => reason.code) ?? [];

test("fresher cached details supply consumption and expiration without inventing budget IDs", () => {
    const listTime = "2026-11-06T20:00:00Z";
    const detailTime = "2026-11-06T21:00:00Z";
    const list = [budget({scope: "user", consumed: null, expiresAt: null})];
    const details = [
        budget({scope: "user", consumed: 101, expiresAt: "2026-11-07", fetchedAt: detailTime}),
        budget({id: "saved-only", consumed: 90, fetchedAt: detailTime}),
    ];
    const merged = mergeAttentionBudgets(list, listTime, details);
    const {rows, coverage} = buildAttentionQueue(merged, now);
    assert.deepEqual(merged.map(record => record.id), ["budget-one", "saved-only"]);
    assert.equal(rows[0].budget.fetchedAt, detailTime);
    assert.deepEqual(rows[0].reasons.map(reason => reason.code), ["above-limit", "override-expiring"]);
    assert.deepEqual(coverage, {total: 2, comparable: 2, unavailable: 0});
    assert.equal(list[0].consumed, null);
});

test("cached record merge honors recency, does not fill newer unknowns from older values, and deduplicates", () => {
    const listTime = "2026-11-06T20:00:00Z";
    const list = [budget({consumed: 100, scope: "user", expiresAt: "2026-11-07"})];
    const older = budget({consumed: 1, fetchedAt: "2026-11-06T19:00:00Z"});
    assert.equal(mergeAttentionBudgets(list, listTime, [older])[0].consumed, 100);
    const newer = budget({scope: "user", consumed: null, expiresAt: null, fetchedAt: "2026-11-06T21:00:00Z"});
    const merged = mergeAttentionBudgets(list, listTime, [newer, older, newer]);
    assert.equal(merged.length, 1);
    assert.deepEqual(buildAttentionQueue(merged, now).rows, []);
    assert.equal(buildAttentionQueue(merged, now).coverage.unavailable, 1);
    assert.equal(mergeAttentionBudgets(list, listTime, [budget({fetchedAt: "invalid"})])[0].consumed, 100);
    assert.equal(mergeAttentionBudgets(list, listTime)[0].fetchedAt, listTime);
});

test("usage signals distinguish the 90%, exhausted and above-limit boundaries without duplicate rows", () => {
    assert.deepEqual(reasons({consumed: 89.999}), []);
    assert.deepEqual(reasons({consumed: 90}), ["near-limit"]);
    assert.deepEqual(reasons({consumed: 99.999}), ["near-limit"]);
    assert.deepEqual(reasons({consumed: 100}), ["exhausted"]);
    assert.deepEqual(reasons({consumed: 100.001}), ["above-limit"]);
    assert.deepEqual(reasons({consumed: 100, preventFurtherUsage: false}), ["alerts-only-reached"]);
    assert.deepEqual(reasons({consumed: 101, preventFurtherUsage: false}), ["alerts-only-exceeded"]);
    assert.deepEqual(reasons({consumed: 101, preventFurtherUsage: false, alerts: false}), ["above-limit"]);
    assert.deepEqual(reasons({consumed: 101, preventFurtherUsage: null}), ["above-limit"]);
});

test("zero limits do not divide, and unknown or invalid values and units never imply usage risk", () => {
    for (const consumed of [0, 1]) {
        const {rows} = buildAttentionQueue([budget({amount: 0, consumed})], now);
        assert.equal(rows[0].percent, null);
        assert.equal(rows[0].reasons[0].code, consumed === 0 ? "exhausted" : "above-limit");
    }
    for (const value of [null, undefined, -1, NaN, Infinity, "100"]) {
        assert.deepEqual(reasons({consumed: value}), []);
        assert.deepEqual(reasons({amount: value, consumed: 100}), []);
    }
    assert.deepEqual(reasons({product: "unknown", consumed: 100}), []);
    assert.deepEqual(reasons({product: "actions", type: "UnknownPricing", consumed: 100}), []);
    assert.deepEqual(reasons({product: "ghas_licenses", type: "SkuPricing", consumed: 90}), ["near-limit"]);
    const extreme = buildAttentionQueue([budget({amount: Number.MIN_VALUE, consumed: Number.MAX_VALUE})], now);
    assert.equal(extreme.rows[0].percent, null);
    assert.equal(extreme.rows[0].reasons[0].code, "above-limit");
});

test("upcoming expiration uses UTC calendar days, excludes expired timestamps, and validates dates", () => {
    assert.equal(expirationDays("2026-11-06", now), 0);
    assert.equal(expirationDays("2026-11-13", now), 7);
    assert.equal(expirationDays("2026-11-13T23:59:59Z", now), 7);
    assert.equal(expirationDays("2026-11-14T00:00:00Z", now), null);
    assert.equal(expirationDays("2026-11-05", now), null);
    assert.equal(expirationDays("2026-11-06T22:29:59Z", now), null);
    assert.equal(expirationDays("2026-11-06T22:30:00Z", now), 0);
    assert.equal(expirationDays("2026-11-14T00:30:00+02:00", now), 7);
    assert.equal(expirationDays("2026-11-07T00:30:00+02:00", now), 0);
    for (const value of [null, undefined, "", "soon", "2026-02-30", "2026-11-07T24:00:00Z", "2026-11-07T00:00:00"]) {
        assert.equal(expirationDays(value, now), null);
    }
    assert.equal(expirationDays("2028-02-29", "2028-02-22T00:00:00Z"), 7);
});

test("only individual overrides expire; expiration is independent of usage and shares a single budget row", () => {
    assert.deepEqual(reasons({scope: "user", expiresAt: "2026-11-07", consumed: null, product: "unknown"}), ["override-expiring"]);
    assert.deepEqual(reasons({scope: "multi_user_customer", expiresAt: "2026-11-07"}), []);
    assert.deepEqual(reasons({scope: "multi_user_cost_center", expiresAt: "2026-11-07"}), []);
    assert.deepEqual(reasons({scope: "user", expiresAt: "2026-11-05"}), []);
    const result = buildAttentionQueue([budget({scope: "user", expiresAt: "2026-11-07", consumed: 100})], now);
    assert.equal(result.rows.length, 1);
    assert.deepEqual(result.rows[0].reasons.map(reason => reason.code), ["exhausted", "override-expiring"]);
    assert.equal(result.rows[0].severity, "critical");
});

test("coverage, severity ordering, scope/product filters and pagination reflect only the saved list", () => {
    const data = [
        budget({id: "near", consumed: 90}),
        budget({id: "above", scope: "user", consumed: 101}),
        budget({id: "unknown", product: "unknown", consumed: 101}),
        ...Array.from({length: 26}, (_, index) => budget({id: `license-${index}`, product: "ghec", consumed: 100})),
    ];
    const {rows, coverage} = buildAttentionQueue(data, now);
    assert.deepEqual(coverage, {total: 29, comparable: 28, unavailable: 1});
    assert.equal(rows[0].severity, "critical");
    assert.equal(rows.at(-1).budget.id, "near");
    assert.equal(paginateAttention(rows, "", "", 1).items.length, 25);
    assert.equal(paginateAttention(rows, "", "", 99).items.length, 3);
    assert.equal(paginateAttention(rows, "", "ghec", 2).items.length, 1);
    assert.equal(paginateAttention(rows, "user", "actions", 99).items[0].budget.id, "above");
    assert.equal(paginateAttention(rows, "user", "ghec", 99).total, 0);
});
