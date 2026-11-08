import {test} from "node:test";
import assert from "node:assert/strict";
import {userChain, userUsage, userSpending, placeBudgets} from "./ui/user-card.mjs";

const center = {id:"center-one", name:"Center one"};
const attribution = fields => ({status:"confirmed", method:"team", center, unresolved:[], alternatives:[],
    via:{kind:"team", name:"Platform", slug:"platform", htmlUrl:null}, ...fields});
const user = fields => ({login:"sample-user", enterpriseTeams:{items:[{slug:"a"},{slug:"b"}]}, ...fields});
const kinds = chain => chain.links.map(link => link.kind);
const budget = (id, scope, amount = 25) => ({id, scope, type:"BundlePricing", product:"ai_credits", amount, consumed:null});

test("confirmed team path charges through team and center; center only belongs to the enterprise", () => {
    const chain = userChain(user({attribution:attribution()}), "example-enterprise");
    assert.deepEqual(chain.steps.map(step => step.state), ["subject", "active", "active", "container"]);
    assert.equal(chain.steps[1].label, "Platform");
    assert.deepEqual(kinds(chain), ["charges", "charges", "contains"]);
});

test("direct assignment bypasses teams and says memberships were not used", () => {
    const chain = userChain(user({attribution:attribution({method:"direct", via:null})}));
    assert.equal(chain.steps[1].kind, "direct");
    assert.match(chain.steps[1].note, /2 team memberships not used/);
});

test("enterprise fallback is only drawn when confirmed; unresolved and provisional never assert charging", () => {
    const fallback = userChain(user({attribution:attribution({method:"enterprise", center:null, via:null})}));
    assert.deepEqual(kinds(fallback), ["skipped", "skipped", "charges"]);
    assert.equal(fallback.steps[3].state, "active");
    const unresolved = userChain(user({attribution:attribution({status:"unresolved", method:"enterprise", center:null, via:null,
        lastConfirmed:{center, method:"team", checkedAt:"2026-01-01T00:00:00Z"}})}));
    assert.ok(!kinds(unresolved).includes("charges"));
    assert.equal(unresolved.steps[2].label, "Unknown");
    assert.equal(unresolved.steps[3].state, "container");
    assert.equal(unresolved.lastConfirmed.center.id, "center-one");
    const provisional = userChain(user({attribution:attribution({status:"provisional", method:"direct", via:null})}));
    assert.deepEqual(kinds(provisional), ["tentative", "tentative", "contains"]);
    const unchecked = userChain(user({}));
    assert.equal(unchecked.status, "unchecked");
    assert.ok(!kinds(unchecked).includes("charges"));
    const unresolvedTeam = userChain(user({attribution:attribution({status:"unresolved", center:null})}));
    assert.equal(unresolvedTeam.steps[1].label, "Team precedence unresolved");
    assert.equal(unresolvedTeam.links[0].label, "not established");
});

test("usage meter states distinguish missing cap, zero cap, exhaustion and unknown usage", () => {
    const usage = (amount, consumed, headroom = null) => userUsage({effective:{id:"b", amount, consumed, budget:budget("b", "user", amount)}, title:"Individual"},
        {headroom});
    assert.equal(userUsage({effective:null, reason:"No cap"}, {headroom:null}).state, "no_cap");
    assert.equal(usage(0, 0).state, "zero_cap");
    assert.equal(usage(0, 1).state, "exceeded");
    assert.equal(usage(10, 12).state, "exceeded");
    assert.equal(usage(10, 10).state, "reached");
    assert.equal(usage(10, null).state, "unknown_usage");
    assert.equal(usage(null, 1).state, "unknown");
    assert.equal(usage(10, 2, 8).state, "within");
});

test("spending keeps no-report, denied and unchecked distinct from zero", () => {
    assert.equal(userSpending(undefined).state, "not_checked");
    assert.equal(userSpending({status:"none_reported", message:"x"}).state, "none_reported");
    assert.equal(userSpending({status:"error", denied:true, message:"x"}).state, "denied");
    const available = userSpending({status:"available", gross:4, discount:3, net:1, retainedAfterError:"HTTP 502"});
    assert.deepEqual([available.net, available.retained], [1, "HTTP 502"]);
});

test("budgets sit on their owning level; off-path centers are not drawn on the active path", () => {
    const chain = userChain(user({attribution:attribution()}));
    const other = {id:"center-two", name:"Center two"};
    const placed = placeBudgets({controls:[
        {budget:budget("ind", "user"), state:"effective", center:null},
        {budget:budget("cc", "multi_user_cost_center"), state:"overridden", center},
        {budget:budget("cc2", "multi_user_cost_center"), state:"unconfirmed", center:other},
        {budget:budget("ent", "multi_user_customer"), state:"overridden", center:null},
    ], guardrails:[
        {budget:budget("shared-cc", "cost_center", 500), center},
        {budget:budget("shared-ent", "enterprise", 5000), center:null},
    ]}, chain);
    assert.deepEqual(placed.user.map(chip => [chip.id, chip.state]), [["ind", "effective"]]);
    assert.deepEqual(placed.center.map(chip => [chip.id, chip.kind]), [["cc", "per_user"], ["shared-cc", "shared"]]);
    assert.deepEqual(placed.enterprise.map(chip => chip.id), ["ent", "shared-ent"]);
    assert.deepEqual(placed.other.map(chip => [chip.id, chip.state]), [["cc2", "candidate"]]);
});
