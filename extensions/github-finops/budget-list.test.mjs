import {test} from "node:test";
import assert from "node:assert/strict";
import {loadBudgets, normalizeBudgetRecord} from "./budget-list.mjs";
import {budgetAmount, budgetEntity, budgetUnit, paginateBudgets, scopeLabel} from "./ui/budget-format.mjs";

const config = {enterprise: "example-enterprise", host: "github.com"};
const raw = (fields = {}) => ({
    id: "budget-one", budget_scope: "enterprise", budget_type: "ProductPricing",
    budget_product_sku: "actions", budget_amount: 80, prevent_further_usage: false,
    budget_alerting: {will_alert: false, alert_recipients: []}, ...fields,
});

test("loads all budget pages without scope/product filters or per-row detail requests", async () => {
    const requests = [];
    const result = await loadBudgets(config, async path => {
        requests.push(path);
        return path.endsWith("page=1") ? {
            budgets: Array.from({length:25}, (_,i) => raw({id:`budget-${i}`})), has_next_page:true,
        } : {budgets:[raw({id:"budget-last", budget_scope:"user", user:"example-user",
            budget_type:"BundlePricing",budget_product_sku:"ai_credits",expires_at:"2027-01-01"})],has_next_page:false};
    });
    assert.equal(requests.length, 2);
    assert.ok(requests.every(path => !path.includes("scope=")));
    assert.equal(result.length, 26);
    assert.equal(result[25].expiresAt, "2027-01-01");
    const filtered = paginateBudgets(result, "example-user", 99);
    assert.equal(filtered.page, 1);
    assert.equal(filtered.items[0].id, "budget-last");
    assert.equal(paginateBudgets(result, "", 1).items.length, 25);
    assert.equal(paginateBudgets(result, "", 2).items.length, 1);
});

test("budget details retain optional settings, explicit zero and missing consumption", async () => {
    const result = await loadBudgets(config, async () => raw({budget_amount:0,consumed_amount:0,
        budget_entity_name:"example-org",budget_scope:"organization",
        budget_alerting:{will_alert:true,alert_recipients:["example-user"]},expires_at:null}), "budget-one");
    assert.equal(result.amount, 0);
    assert.equal(result.consumed, 0);
    assert.equal(result.expiresAt, null);
    assert.equal(result.alerts, true);
    assert.deepEqual(result.alertRecipients, ["example-user"]);
    assert.equal(normalizeBudgetRecord(raw()).consumed, null);
    assert.equal(normalizeBudgetRecord(raw()).expiresAt, undefined);
});

test("malformed or non-progressing budget pages and invalid details fail explicitly", async () => {
    await assert.rejects(loadBudgets(config, async () => ({budgets:[],has_next_page:true})), /incomplete/);
    await assert.rejects(loadBudgets(config, async () => ({budgets:[raw()],has_next_page:true})), /repeated/);
    await assert.rejects(loadBudgets(config, async () => raw({id:"other"}), "budget-one"), /identity/);
    await assert.rejects(loadBudgets(config, async () => ({}), "../bad"), /Invalid budget ID/);
    assert.throws(() => normalizeBudgetRecord(raw({budget_scope:undefined})), /unexpected/);
    assert.throws(() => normalizeBudgetRecord(raw({consumed_amount:-1})), /Invalid/);
    assert.throws(() => normalizeBudgetRecord(raw({budget_alerting:{alert_recipients:[4]}})), /recipients/);
});

test("shows USD, license counts, per-user scopes and unknown units without inventing values", () => {
    const money = normalizeBudgetRecord(raw());
    const license = normalizeBudgetRecord(raw({budget_type:"SkuPricing",budget_product_sku:"ghas_code_security_licenses"}));
    const unknown = normalizeBudgetRecord(raw({budget_type:"SkuPricing",budget_product_sku:"future_product"}));
    assert.equal(budgetUnit(money), "USD");
    assert.equal(budgetUnit(license), "licenses");
    assert.equal(budgetUnit(normalizeBudgetRecord(raw({budget_product_sku:"ghec"}))), "licenses");
    assert.equal(budgetUnit(unknown), null);
    assert.match(budgetAmount(3, license), /^3 licenses$/);
    assert.match(budgetAmount(3, unknown), /unit not returned/);
    assert.equal(budgetAmount(null, money), "Unavailable");
    assert.match(budgetAmount(0, money), /0\.00.*USD/);
    assert.equal(scopeLabel("multi_user_cost_center"), "Cost center per-user default");
    assert.equal(budgetEntity(normalizeBudgetRecord(raw({budget_scope:"user",user:"example-user"}))), "example-user");
    assert.equal(budgetEntity(normalizeBudgetRecord(raw({budget_scope:"cost_center"}))), "Not returned");
    assert.equal(scopeLabel("constructor"), "constructor");
});

test("budget pagination clamps after search, empty lists and 25-row boundaries", () => {
    for (const size of [0,25,26,50,51]) {
        const rows = Array.from({length:size}, (_,i) => normalizeBudgetRecord(raw({id:`budget-${i}`})));
        const last = paginateBudgets(rows, "", 999);
        assert.ok(last.items.length <= 25);
        assert.equal(last.end, size);
        assert.equal(last.page, Math.max(1,Math.ceil(size/25)));
        assert.equal(paginateBudgets(rows, "no match", 999).page, 1);
    }
});
