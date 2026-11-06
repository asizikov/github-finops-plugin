import {test} from "node:test";
import assert from "node:assert/strict";
import {explainUserBudget} from "./ui/user-explanation.mjs";

const budget = (scope, fields = {}) => ({
    id: `${scope}-budget`, scope, type: "BundlePricing", product: "ai_credits",
    amount: 25, consumed: 8, expiresAt: null, ...fields,
});
const user = (scope, {effectiveStatus = "reported", filterVerified = true, expiresAt, overridden = []} = {}) => {
    const effectiveBudget = budget(scope, {expiresAt});
    return {
        filterVerified, effectiveStatus,
        effective: {id: effectiveBudget.id, amount: 25, consumed: 8, budget: effectiveBudget},
        controls: [{budget: effectiveBudget, state: "effective"}, ...overridden.map(item => ({...item, state: "overridden"}))],
    };
};
const explain = input => {
    const value = user("user", input);
    return explainUserBudget({
        filterVerified: value.filterVerified, effectiveStatus: value.effectiveStatus,
    }, {effective: value.effective, controls: value.controls});
};

test("explains the three API-selected per-user budget sources distinctly", () => {
    const cases = [
        ["user", "individual", "Individual user override"],
        ["multi_user_cost_center", "cost_center", "Cost-center per-user default"],
        ["multi_user_customer", "enterprise", "Enterprise per-user default"],
    ];
    for (const [scope, kind, title] of cases) {
        const result = explainUserBudget({
            filterVerified: true, effectiveStatus: "reported",
        }, {effective: {...user(scope).effective}, controls: []});
        assert.equal(result.kind, kind);
        assert.equal(result.title, title);
        assert.match(result.rationale, /GitHub selected/);
        assert.equal(result.effective.amount, 25);
        assert.equal(result.effective.consumed, 8);
    }
});

test("only API-classified overridden controls are included and expiration stays unknown unless returned", () => {
    const overridden = {budget: budget("multi_user_customer"), center: null};
    const result = explain({
        overridden: [overridden],
    });
    assert.equal(result.overridden.length, 1);
    assert.equal(result.overridden[0].budget.scope, "multi_user_customer");
    assert.equal(result.expiration, null);
    assert.equal(explain({expiresAt: "2027-01-31"}).expiration, "2027-01-31");
});

test("missing and unverified effective data never imply a zero, unlimited, or blocked allowance", () => {
    for (const [input, expected] of [
        [{effectiveStatus: "not_returned"}, "The API did not return"],
        [{effectiveStatus: "none_reported"}, "GitHub reported no effective"],
        [{filterVerified: false}, "did not confirm the requested username"],
    ]) {
        const value = user("user", input);
        const result = explainUserBudget({
            filterVerified: value.filterVerified, effectiveStatus: value.effectiveStatus,
        }, {effective: null, controls: []});
        assert.equal(result.effective, null);
        assert.match(result.reason, new RegExp(expected));
        assert.deepEqual(result.overridden, []);
    }
});

test("unrecognized selected scopes remain explicitly unclassified", () => {
    const effective = user("organization").effective;
    effective.budget.scope = "organization";
    const result = explainUserBudget({filterVerified: true, effectiveStatus: "reported"}, {effective, controls: []});
    assert.equal(result.kind, "unknown");
    assert.match(result.rationale, /Billing assignment is not inferred/);
});

test("partial effective values remain unavailable rather than becoming zero", () => {
    const effective = user("user").effective;
    effective.amount = null;
    effective.consumed = null;
    const result = explainUserBudget({filterVerified: true, effectiveStatus: "reported"}, {effective, controls: []});
    assert.equal(result.effective.amount, null);
    assert.equal(result.effective.consumed, null);
});
