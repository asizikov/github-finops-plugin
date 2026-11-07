import { test } from "node:test";
import assert from "node:assert/strict";
import { loadOverview, normalizeBudget, validateInput } from "./budgets.mjs";

const config = { enterprise: "example-enterprise" };
const emptyUsage = () => ({
    timePeriod: { year: new Date().getUTCFullYear(), month: new Date().getUTCMonth() + 1 },
    usageItems: [],
});
const budget = (scope, fields = {}) => ({
    id: `budget-${scope.replaceAll("_", "-")}`,
    budget_scope: scope,
    budget_type: "BundlePricing",
    budget_product_sku: "ai_credits",
    budget_amount: 50,
    prevent_further_usage: false,
    budget_alerting: { will_alert: true },
    ...fields,
});

test("paginates and filters AI Credits bundles, then reads consumption from details", async () => {
    const requests = [];
    const read = async (path) => {
        requests.push(path);
        if (path.includes("/ai_credit/usage")) return emptyUsage();
        if (path.includes("scope=enterprise")) {
            return path.endsWith("page=1")
                ? { budgets: [budget("enterprise", { budget_type: "SkuPricing" })], has_next_page: true }
                : { budgets: [budget("enterprise")], has_next_page: false };
        }
        if (path.includes("scope=multi_user_customer")) {
            return { budgets: [budget("multi_user_customer")], has_next_page: false };
        }
        return path.endsWith("budget-enterprise")
            ? budget("enterprise", { consumed_amount: 70, exclude_cost_center_usage: false })
            : budget("multi_user_customer", { prevent_further_usage: true });
    };
    const result = await loadOverview(config, read);
    assert.equal(result.budgets[0].consumed, 70);
    assert.equal(result.budgets[0].excludeCostCenters, false);
    assert.equal(result.budgets[1].consumed, null);
    assert.equal(result.budgets[1].preventFurtherUsage, true);
    assert.equal(requests.length, 6);
    assert.ok(!JSON.stringify(result).includes("example-enterprise"));
});

test("missing budgets remain unconfigured, not zero", async () => {
    const result = await loadOverview(config, async path => path.includes("/ai_credit/usage")
        ? emptyUsage() : { budgets: [], has_next_page: false });
    assert.deepEqual(result.budgets, [
        { scope: "enterprise", configured: false },
        { scope: "multi_user_customer", configured: false },
    ]);
});

test("zero amounts and false flags are preserved while missing fields remain unknown", () => {
    const result = normalizeBudget({ budget_amount: 0, consumed_amount: 0, prevent_further_usage: false }, "enterprise");
    assert.equal(result.amount, 0);
    assert.equal(result.consumed, 0);
    assert.equal(result.preventFurtherUsage, false);
    assert.equal(result.alerts, null);
    assert.equal(result.excludeCostCenters, null);
});

test("invalid values, API failures, malformed responses and duplicate budgets fail explicitly", async (t) => {
    t.mock.method(console, "error", () => {});
    assert.throws(() => normalizeBudget({ budget_amount: "50" }, "enterprise"), /Invalid/);
    assert.throws(() => normalizeBudget({ consumed_amount: -1 }, "enterprise"), /Invalid/);
    await assert.rejects(loadOverview(config, async () => { throw new Error("Permission denied"); }), /Permission denied/);
    await assert.rejects(loadOverview(config, async () => ({})), /unexpected budget list/);
    await assert.rejects(loadOverview(config, async () => ({
        budgets: [budget("enterprise"), budget("enterprise")], has_next_page: false,
    })), /repeated/);
});

test("overview preserves multiple universal controls and non-AI product units without combining limits", async () => {
    const controls = [budget("multi_user_customer"), budget("multi_user_customer", {
        id: "sku-universal", budget_type: "SkuPricing", budget_product_sku: "copilot_ai_credit", budget_amount: 10,
    })];
    const result = await loadOverview(config, async path => {
        if (path.includes("/ai_credit/usage")) return emptyUsage();
        if (path.includes("scope=enterprise")) return {budgets: [], has_next_page: false};
        if (path.includes("?scope=")) return {budgets: controls, has_next_page: false};
        return controls.find(control => path.endsWith(control.id));
    });
    assert.equal(result.budgets.length, 3);
    assert.deepEqual(result.budgets.slice(1).map(({id,amount,product}) => ({id,amount,product})), [
        {id: controls[0].id, amount: 50, product: "ai_credits"},
        {id: "sku-universal", amount: 10, product: "copilot_ai_credit"},
    ]);
});

test("inaccessible spending is explicit and does not hide successfully read budgets", async (t) => {
    const log = t.mock.method(console, "error", () => {});
    const result = await loadOverview(config, async path => {
        if (path.includes("/ai_credit/usage")) throw new Error("Forbidden");
        return { budgets: [], has_next_page: false };
    });
    assert.equal(result.budgets.length, 2);
    assert.equal(result.spending.status, "error");
    assert.match(result.spending.message, /Could not read current AI spending/);
    assert.equal(log.mock.callCount(), 1);
});

test("validates slug and host before invoking gh", () => {
    assert.deepEqual(validateInput(config), { enterprise: "example-enterprise", host: "github.com" });
    for (const enterprise of ["../other", "--help", "", "two words"]) {
        assert.throws(() => validateInput({ enterprise }));
    }
    for (const host of ["https://github.com", "github.com/api", "-evil", "a..b"]) {
        assert.throws(() => validateInput({ ...config, host }));
    }
});
