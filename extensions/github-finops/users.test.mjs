import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFileSync} from "node:child_process";
import {loadUser} from "./users.mjs";
import {normalizeUsername, resolveUserBudgets} from "./ui/user-format.mjs";
import {normalizeBudgetRecord} from "./budget-list.mjs";
import {SnapshotStore, OverviewCache} from "./cache.mjs";
import {GitHubReadError} from "./github.mjs";

const config = {enterprise:"example-enterprise",host:"github.com"};
const login = "sample-user";
const profile = {login,id:12,type:"User"};
const membership = {resource:{type:"user",identifier:{login}},memberships:[{cost_center:{id:"center-one",name:"Engineering"}}]};
const raw = (id, scope = "user", entity = login, fields = {}) => ({
    id,budget_scope:scope,budget_entity_name:entity,budget_type:"BundlePricing",budget_product_sku:"ai_credits",
    budget_amount:20,consumed_amount:3,prevent_further_usage:true,
    ...fields,
});
const userBudget = raw("user-budget");
const defaultBudget = raw("default-budget","multi_user_customer","example-enterprise",{budget_amount:40});
const page = (budgets = [userBudget,defaultBudget], extra = {}) => ({
    user:login,budgets,has_next_page:false,effective_budget:{id:"user-budget",budget_amount:20,consumed_amount:3},...extra,
});
function reader({members = membership, pages = [page()], detail = userBudget} = {}) {
    const calls = [];
    return {calls,read:async path => {
        calls.push(path);
        if (path.startsWith("/users/")) return profile;
        if (path.includes("/memberships?")) return members;
        if (path.includes("/budgets?")) return pages[Number(new URL(`https://example.test${path}`).searchParams.get("page")) - 1];
        return detail;
    }};
}
async function data() {
    return loadUser(config,reader().read,login,new Date("2025-01-02T00:00:00Z"));
}
const normalized = (...args) => normalizeBudgetRecord(raw(...args));
function relationships(budgets = [], extra = {}) {
    return {centers:[{id:"center-one",name:"Engineering",fetchedAt:"2025-01-01T00:00:00Z"}],budgets,links:[],
        lists:{centers:{fetchedAt:"2025-01-01T00:00:00Z",error:null},budgets:null},unresolved:[],...extra};
}

test("normalizes pasted usernames without accepting URLs or starting reads for invalid input", async () => {
    assert.equal(normalizeUsername("  @Sample-User  "),"sample-user");
    assert.equal(normalizeUsername("managed_user"),"managed_user");
    for (const invalid of ["","@@name","https://github.com/name","name/other","a b","-name"]) {
        assert.throws(() => normalizeUsername(invalid),/username/);
        await assert.rejects(loadUser(config,async () => {assert.fail("No reads for invalid input");},invalid),/username/);
    }
});

test("resolves identity, authoritative membership IDs and every user-budget page without detail fanout", async () => {
    const {calls,read} = reader({pages:[page([userBudget],{has_next_page:true}),page([defaultBudget])]});
    const result = await loadUser(config,read," @Sample-User ",new Date("2025-01-31T23:59:59Z"));
    assert.equal(result.login,login);
    assert.deepEqual(result.memberships,[{id:"center-one",name:"Engineering"}]);
    assert.equal(result.filterVerified,true);
    assert.equal(result.budgets.length,2);
    assert.deepEqual(result.period,{year:2025,month:1});
    assert.equal(calls.length,4);
    assert.match(calls[3],/user=sample-user&per_page=100&page=2$/);
});

test("user identity, membership identity and non-progressing or changing budget pages fail explicitly", async () => {
    for (const options of [
        {members:{...membership,resource:{type:"user",identifier:{login:"different-user"}}}},
        {members:{...membership,has_next_page:true}},
        {pages:[page([], {user:"different-user"})]},
        {pages:[page([], {has_next_page:true})]},
        {pages:[page([userBudget],{has_next_page:true}),page([userBudget])]},
        {pages:[page([userBudget],{has_next_page:true}),page([defaultBudget],{effective_budget:null})]},
    ]) await assert.rejects(loadUser(config,reader(options).read,login),/GitHub|effective user budget/);
});

test("missing effective metadata never means zero or unlimited; detail consumption is not attributed to the user", async () => {
    for (const value of [undefined,null]) {
        const result = await loadUser(config,reader({pages:[page([defaultBudget],{effective_budget:value})]}).read,login);
        assert.equal(result.effective,null);
        assert.equal(result.effectiveStatus,value === null ? "none_reported" : "not_returned");
        assert.equal(resolveUserBudgets(result).effective,null);
    }
    const result = await loadUser(config,reader({pages:[page([])],
        detail:{...userBudget,consumed_amount:999}}).read,login);
    assert.equal(result.budgets[0].consumed,null);
    assert.equal(result.budgets[0].lookupSource,"effective_detail");
    assert.equal(resolveUserBudgets(result).controls[0].source,"effective_detail");
    assert.equal(result.effective.consumed,3);
    assert.equal(resolveUserBudgets(result).headroom,17);
    const unverified = await loadUser(config,reader({pages:[page([userBudget],{user:undefined})]}).read,login);
    assert.equal(resolveUserBudgets(unverified).effective,null);
});

test("reports not-found, access denied and unavailable billing distinctly without replacing rate-limit errors", async () => {
    for (const [stage,status,message] of [
        ["profile",404,/User not found or not visible/],["profile",403,/Access denied/],
        ["memberships",404,/memberships unavailable/],["budgets",403,/Access denied/],
    ]) {
        const source = reader();
        await assert.rejects(loadUser(config,async path => {
            if ((stage === "profile" && path.startsWith("/users/")) ||
                (stage === "memberships" && path.includes("/memberships?")) ||
                (stage === "budgets" && path.includes("/budgets?"))) throw new GitHubReadError("Denied",null,status);
            return source.read(path);
        },login),message);
    }
    const limited = new GitHubReadError("Limited","2025-01-02T00:02:00Z",429);
    await assert.rejects(loadUser(config,async () => {throw limited;},login),error => error === limited);
});

test("effective per-user controls and overridden defaults follow the API rather than guessed precedence", async () => {
    const user = await data();
    const centerDefault = normalized("center-default","multi_user_cost_center","center-one");
    user.budgets.push(centerDefault);
    const impact = resolveUserBudgets(user);
    assert.deepEqual(impact.controls.map(item => item.state),["effective","overridden","overridden"]);
    assert.equal(impact.headroom,17);
    user.effective = {id:"center-default",amount:0,consumed:0};
    const centerEffective = resolveUserBudgets(user);
    assert.equal(centerEffective.effective.budget.scope,"multi_user_cost_center");
    assert.equal(centerEffective.headroom,0);
    assert.equal(centerEffective.controls.find(item => item.budget.scope === "user").state,"unconfirmed");
    user.effective = null;
    assert.ok(resolveUserBudgets(user).controls.every(item => item.state === "unconfirmed"));
});

test("unrelated and ambiguous defaults are not treated as controls; active API selection can differ from direct memberships", async () => {
    const user = await data();
    user.budgets.push(normalized("foreign-user","user","other-user"),
        normalized("ambiguous","multi_user_cost_center","Engineering"));
    const saved = relationships([],{centers:[
        {id:"center-one",name:"Engineering"},{id:"center-two",name:"Engineering"}],
        unresolved:[{budgetId:"ambiguous",reason:"ambiguous_name"}]});
    const impact = resolveUserBudgets(user,saved);
    assert.equal(impact.excluded,2);
    assert.equal(impact.controls.length,2);
    user.effective = {id:"foreign-user",amount:10,consumed:0};
    assert.equal(resolveUserBudgets(user,saved).effective,null);
    user.effective = {id:"ambiguous",amount:10,consumed:null};
    const selected = resolveUserBudgets(user,saved);
    assert.equal(selected.effective.id,"ambiguous");
    assert.equal(selected.controls.find(item => item.budget.id === "ambiguous").center,null);
    assert.equal(selected.headroom,null);
});

test("guardrails reuse ID/name provenance but never equate membership or saved ownership with billing assignment", async () => {
    const user = await data();
    const budgets = [
        normalized("aggregate","enterprise","example-enterprise",{exclude_cost_center_usage:true}),
        normalized("center-aggregate","cost_center","center-one"),
        normalized("named","cost_center","Engineering"),
        normalized("irrelevant-center","cost_center","unrelated-center"),
        normalized("irrelevant-org","organization","unrelated-org"),
        normalized("other-product","enterprise","example-enterprise",{budget_product_sku:"actions",budget_type:"ProductPricing"}),
        normalized("saved-default","multi_user_cost_center","center-one"),
    ];
    const saved = relationships(budgets,{links:[{budgetId:"named",centerId:"center-one",matchedBy:"exact_unique_name"}]});
    const impact = resolveUserBudgets(user,saved);
    assert.equal(impact.guardrails.length,3);
    assert.match(impact.guardrails[0].reason,/assignment is unknown/);
    assert.equal(impact.guardrails[1].center.matchedBy,"id");
    assert.equal(impact.guardrails[2].center.matchedBy,"exact_unique_name");
    assert.equal(impact.controls.find(item => item.budget.id === "saved-default").state,"unconfirmed");
    saved.lists.centers = null;
    assert.equal(resolveUserBudgets(user,saved).guardrails.length,2);
    saved.lists.centers = {fetchedAt:"2025-01-01T00:00:00Z",error:null};
    saved.centers[0].name = "Renamed";
    assert.equal(resolveUserBudgets(user,saved).guardrails.length,2);
});

function cachedSetup(t) {
    const root = mkdtempSync(join(tmpdir(),"finops-user-cache-"));
    const path = join(root,"cache.sqlite");
    const store = new SnapshotStore(path);
    const source = reader();
    const state = {account:"one",now:new Date("2025-01-02T00:00:00Z"),failure:null,attempts:0};
    const options = {identity:async () => state.account,clock:() => state.now,read:async path => {
        state.attempts++;
        if (state.failure) throw state.failure;
        return source.read(path);
    }};
    const cache = new OverviewCache(store,options);
    t.after(() => {store.close();rmSync(root,{recursive:true});});
    return {cache,store,state,source,path};
}

test("cached normalized user searches and restart persistence make zero GitHub calls without polluting relationship indexes", async t => {
    const {cache,store,source,path} = cachedSetup(t);
    const result = await cache.get(config,{resource:"user",id:" @Sample-User "});
    assert.equal(result.cache.source,"live");
    assert.equal(source.calls.length,3);
    assert.equal((await cache.get(config,{resource:"user",id:"SAMPLE-USER"})).cache.source,"cached");
    assert.equal(source.calls.length,3);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM relationship_budgets").get().n,0);
    const script = `
      import {SnapshotStore,OverviewCache} from ${JSON.stringify(new URL("./cache.mjs",import.meta.url).href)};
      const store = new SnapshotStore(${JSON.stringify(path)});
      const cache = new OverviewCache(store,{identity:async () => "one",
        clock:() => new Date("2025-01-02T00:00:00Z"),read:async () => {throw new Error("No API reads");}});
      console.log(JSON.stringify(await cache.get(${JSON.stringify(config)},{resource:"user",id:"sample-user"})));
      store.close();
    `;
    const restart = JSON.parse(execFileSync(process.execPath,["--input-type=module","-e",script],{encoding:"utf8"}));
    assert.equal(restart.cache.source,"cached");
    assert.equal(restart.data.login,login);
});

test("user cache isolates login, host, enterprise, account and billing month", async t => {
    const {cache,state} = cachedSetup(t);
    const options = {resource:"user",id:login};
    await cache.get(config,options);
    state.account = "two";
    assert.equal((await cache.get(config,options)).cache.source,"live");
    state.account = "one";
    assert.equal((await cache.get(config,options)).cache.source,"cached");
    assert.equal((await cache.get({...config,host:"example.test"},options)).cache.source,"live");
    assert.equal((await cache.get({...config,enterprise:"different-enterprise"},options)).cache.source,"live");
    assert.equal((await cache.get(config,{...options,id:"renamed-alias"})).cache.source,"live");
    state.now = new Date("2025-02-01T00:00:00Z");
    assert.equal((await cache.get(config,options)).data.period.month,2);
    assert.equal(state.attempts,18);
});

test("failed or limited refresh keeps last-good user state, persists errors and avoids retry storms", async t => {
    t.mock.method(console,"error",() => {});
    const {cache,state} = cachedSetup(t);
    const options = {resource:"user",id:login};
    const first = await cache.get(config,options);
    state.failure = new GitHubReadError("No access",null,403);
    const failed = await cache.get(config,{...options,refresh:true});
    const saved = JSON.parse(JSON.stringify(first.data));
    assert.deepEqual(failed.data,saved);
    assert.equal(failed.cache.fetchedAt,first.cache.fetchedAt);
    assert.match(failed.cache.error,/Access denied/);
    assert.equal((await cache.get(config,options)).cache.error,failed.cache.error);
    state.failure = new GitHubReadError("Rate limited","2025-01-02T00:02:00Z",429);
    const limited = await cache.get(config,{...options,refresh:true});
    assert.equal(limited.cache.retryAt,state.failure.retryAt);
    const count = state.attempts;
    assert.deepEqual((await cache.get(config,{...options,refresh:true})).data,saved);
    assert.equal(state.attempts,count);
});
