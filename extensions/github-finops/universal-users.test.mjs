import {test} from "node:test";
import assert from "node:assert/strict";
import {loadUniversalUsers} from "./universal-users.mjs";
import {buildUniversalAttention, buildAttentionQueue, mergeUserAttentionRows} from "./attention.mjs";

const config = {enterprise: "example-enterprise", host: "github.com"};
const raw = {id: "universal", budget_scope: "multi_user_customer", budget_type: "BundlePricing",
    budget_product_sku: "ai_credits", budget_amount: 100};
const control = {id: "universal", scope: "multi_user_customer", type: "BundlePricing", product: "ai_credits",
    amount: 100, consumed: 500, preventFurtherUsage: true, alerts: false};
const state = (fields = {}) => ({budgetId: "universal", user: "octocat", consumed: 90, target: 100, overrideBudgetId: null, ...fields});
const data = (states, budgets = [control]) => ({budgets, states});
const now = new Date("2026-11-07T00:00:00Z");

test("paginated user states use documented fields without universal threshold filters or profile requests", async () => {
    const calls = [];
    const loaded = await loadUniversalUsers(config, async path => {
        calls.push(path);
        if (!path.includes("user-states")) return {budgets: [raw], has_next_page: false};
        return {user_states: [{user: path.includes("page=1&") ? "octocat" : "another-user", consumed_amount: 9, target_amount: 10}],
            has_next_page: path.includes("page=1&"), total_count: 2};
    }, now);
    assert.equal(calls.length, 3);
    assert.ok(calls.every(path => !path.includes("threshold_") && !path.includes("/users/")));
    assert.equal(loaded.states[0].target, 10);
    assert.deepEqual(loaded.period, {year: 2026, month: 11});
    assert.equal(loaded.coverage.complete, true);
});

test("incomplete, duplicated, changing, denied and safety-limited pagination never returns empty success", async () => {
    for (const response of [
        {user_states: [], has_next_page: true, total_count: 1},
        {user_states: [], has_next_page: false, total_count: 1},
        {user_states: [{user:"octocat",consumed_amount:-1}], has_next_page: false, total_count: 1},
        {user_states: [], has_next_page: false},
    ]) await assert.rejects(loadUniversalUsers(config, async path => path.includes("user-states")
        ? response : {budgets: [raw], has_next_page: false}));
    await assert.rejects(loadUniversalUsers(config, async path => {
        if (!path.includes("user-states")) return {budgets: [raw], has_next_page: false};
        if (path.includes("page=2&")) throw new Error("Forbidden");
        return {user_states: [{user:"octocat",consumed_amount:90,target_amount:100}],has_next_page:true,total_count:2};
    }), /Forbidden/);
    await assert.rejects(loadUniversalUsers(config, async path => {
        if (!path.includes("user-states")) return {budgets: [raw], has_next_page: false};
        return {user_states: [{user:"octocat",consumed_amount:90,target_amount:100}],has_next_page:true,total_count:2};
    }), /repeated/);
    let page = 0;
    await assert.rejects(loadUniversalUsers(config, async path => {
        if (!path.includes("user-states")) return {budgets: [raw], has_next_page: false};
        return {user_states: [{user:`user-${++page}`,consumed_amount:90,target_amount:100}],has_next_page:true,total_count:10000};
    }), /safety limit/);
    assert.equal(page, 20);
});

test("individual boundaries, zero/unknown values and aggregate exclusion", () => {
    assert.equal(buildAttentionQueue([control], now).rows.length, 0);
    for (const [consumed, severity] of [[89.999, null], [90, "warning"], [99.999, "warning"], [100, "critical"], [101, "critical"]]) {
        assert.equal(buildUniversalAttention(data([state({consumed})]), now).rows[0]?.severity ?? null, severity);
    }
    assert.equal(buildUniversalAttention(data([state({target:0,consumed:0})]), now).rows[0].percent, null);
    assert.equal(buildUniversalAttention(data([state({consumed:null})]), now).rows.length, 0);
    assert.equal(buildUniversalAttention(data([state({user:null})]), now).rows.length, 0);
    const unknown = buildUniversalAttention(data([state({target:null})]), now);
    assert.equal(unknown.coverage.comparable, 0);
    assert.equal(unknown.rows[0].severity, "warning");
    assert.match(unknown.rows[0].limitLabel, /not a confirmed limit/);
});

test("reported override and cost-center targets, not the universal denominator, determine risk", () => {
    assert.equal(buildUniversalAttention(data([state({consumed:100,target:200,overrideBudgetId:"override"})]), now).rows.length, 0);
    const lower = buildUniversalAttention(data([state({consumed:9,target:10,overrideBudgetId:"override"})]), now);
    assert.equal(lower.rows[0].percent, 90);
    assert.match(lower.rows[0].applicability, /override/);
    assert.equal(lower.rows[0].universalAmount, 100);
    const costCenter = buildUniversalAttention(data([state({consumed:45,target:50})]), now);
    assert.match(costCenter.rows[0].applicability, /more-specific/);
    const expired = {...control,id:"override",scope:"user",expiresAt:"2026-11-06"};
    const stale = buildUniversalAttention(data([state({consumed:100,target:10,overrideBudgetId:"override"})],[control,expired]), now);
    assert.match(stale.rows[0].applicability, /expired/);
    assert.equal(stale.rows[0].severity, "warning");
    const conflicting = {...control,id:"override",scope:"user",user:"octocat",amount:200};
    const uncertain = buildUniversalAttention(data([state({consumed:100,target:100,overrideBudgetId:"override"})],[control,conflicting]),now);
    assert.match(uncertain.rows[0].applicability,/conflicts/);
    assert.equal(uncertain.rows[0].severity,"warning");
    assert.equal(uncertain.coverage.comparable,0);
    const unselected = buildUniversalAttention(data([state({consumed:100,target:100})],[control,conflicting]),now);
    assert.match(unselected.rows[0].applicability,/conflicts/);
    assert.equal(unselected.rows[0].severity,"warning");
    const ambiguous = buildUniversalAttention(data([state({consumed:100})],[control,conflicting,{...conflicting,id:"other-override"}]),now);
    assert.match(ambiguous.rows[0].applicability,/Multiple/);
    assert.equal(ambiguous.rows[0].severity,"warning");
});

test("deduplication keeps different control and SKU risks for the same user", () => {
    const other = {...control,id:"another",product:"copilot_ai_credit",type:"SkuPricing"};
    const result = buildUniversalAttention(data([state(),state(),state({budgetId:"another"})],[control,other]), now);
    assert.equal(result.rows.length, 2);
    assert.notEqual(result.rows[0].key, result.rows[1].key);
});

test("user-state override signals replace duplicate budget usage without losing expiry or other SKU risks", () => {
    const override = {...control,id:"override",scope:"user",user:"octocat",amount:10,consumed:9,expiresAt:"2026-11-08"};
    const other = {...override,id:"other",product:"copilot_ai_credit",type:"SkuPricing"};
    const budgetRows = buildAttentionQueue([override,other],now).rows;
    const userRows = buildUniversalAttention(data([state({consumed:9,target:10,overrideBudgetId:"override"})],[control,override]),now).rows;
    const rows = mergeUserAttentionRows(budgetRows,userRows);
    assert.equal(rows.length,2);
    assert.equal(rows.filter(row=>row.budget.product==="ai_credits").length,1);
    assert.ok(rows.find(row=>row.user)?.reasons.some(reason=>reason.code==="override-expiring"));
    assert.ok(rows.some(row=>row.budget.id==="other"));
});
