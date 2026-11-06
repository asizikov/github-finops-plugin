import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {collectAttribution, resolveAttribution} from "./attribution.mjs";
import {SnapshotStore, OverviewCache} from "./cache.mjs";
import {loadUser} from "./users.mjs";

const config = {enterprise:"example-enterprise",host:"github.com"};
const login = "sample-user";
const date = "2026-01-02T00:00:00Z";
const center = (id = "center-one") => ({id, name:id});
const team = (slug, createdAt, centers = []) => ({id:slug,name:slug,slug,createdAt,centers,state:"complete"});
const evidence = (fields = {}) => ({checkedAt:date,direct:{state:"complete",candidates:[]},
    teams:{state:"complete",items:[]},license:{state:"complete",organizations:[],unaffiliated:false},...fields});
const resolve = fields => resolveAttribution(evidence(fields));
const membership = (type, name, centers = []) => ({
    resource:{type,identifier:{[type === "user" ? "login" : type === "team" ? "slug" : "name"]:name}},
    memberships:centers.map(value => ({cost_center:value})),
});
const rawTeam = (slug, createdAt) => ({id:1,name:slug,slug,created_at:createdAt,
    html_url:`https://github.com/enterprises/example-enterprise/teams/${slug}`});

test("direct assignment wins over older team, but membership alone does not establish a direct assignment", () => {
    const teams = {state:"complete",items:[team("old-team","2020-01-01T00:00:00Z",[center("team-center")])]};
    const direct = {state:"complete",candidates:[{center:center(),explicit:true}]};
    assert.equal(resolve({direct,teams}).method,"direct");
    direct.candidates[0].explicit = false;
    assert.equal(resolve({direct,teams}).center.id,"team-center");
});

test("only qualifying teams participate; oldest creation time wins, with no arbitrary tie or missing-date winner", () => {
    const items = [team("unassigned","2010-01-01T00:00:00Z"),
        team("newer","2022-01-01T00:00:00Z",[center("new-center")]),
        team("older","2021-01-01T00:00:00Z",[center("old-center")])];
    const teams = {state:"complete",items};
    const result = resolve({teams});
    assert.equal(result.center.id,"old-center");
    assert.match(result.alternatives.find(item => item.slug === "unassigned").reason,/No cost center/);
    assert.match(result.alternatives.find(item => item.slug === "newer").reason,/earlier/);
    items[1].createdAt = items[2].createdAt;
    assert.equal(resolve({teams}).status,"unresolved");
    items[1].createdAt = null;
    assert.match(resolve({teams}).reason,/creation date/);
    items[1].createdAt = "invalid";
    assert.equal(resolve({teams}).center,null);
    items[1].createdAt = "2022-01-01T00:00:00Z";
    items[2].centers.push(center("ambiguous-center"));
    assert.equal(resolve({teams}).status,"unresolved");
});

test("denied, incomplete and ambiguous higher-priority evidence never falls through", () => {
    for (const direct of [{state:"unavailable",reason:"Denied"}, {state:"complete",
        candidates:[{center:center(),explicit:true},{center:center("second"),explicit:true}]}]) {
        assert.notEqual(resolve({direct}).status,"confirmed");
    }
    const candidate = resolve({direct:{state:"unavailable",reason:"Resources incomplete",
        candidates:[{center:center(),explicit:true}]}});
    assert.equal(candidate.status,"provisional");
    for (const teams of [{state:"unavailable",reason:"Denied"}, {state:"complete",
        items:[{...team("partial",date),state:"unavailable"}]}]) {
        assert.equal(resolve({teams}).status,"unresolved");
    }
});

test("sole license organization can win; ambiguous, hidden or team-only seats cannot identify billing organization", () => {
    const organization = {name:"example-org",state:"complete",centers:[center("org-center")]};
    assert.equal(resolve({license:{state:"complete",organizations:[organization]}}).method,"organization");
    assert.equal(resolve({license:{state:"complete",organizations:[organization]}}).center.id,"org-center");
    for (const license of [
        {state:"unavailable",reason:"Denied"},
        {state:"complete",unaffiliated:true,organizations:[]},
        {state:"complete",organizations:[organization,{...organization,name:"other-org"}]},
        {state:"complete",organizations:[{...organization,state:"unavailable"}]},
        {state:"complete",organizations:[{...organization,centers:[center(),center("second")]}]},
    ]) assert.equal(resolve({license}).status,"unresolved");
    assert.equal(resolve({license:{state:"complete",organizations:[{...organization,centers:[]}]}}).method,"enterprise");
    assert.equal(resolve({}).method,"enterprise");
    assert.equal(resolve({}).status,"confirmed");
});

test("explicit user resources are read through all detail pages and repository assignment is ignored", async () => {
    const calls = [];
    const read = async path => {
        calls.push(path);
        assert.match(path,/cost-centers\/center-one\?/);
        return {...center(),state:"active",has_next_page:path.endsWith("page=1"),
            resources:path.endsWith("page=1") ? [{type:"Repo",name:"example-org/example-repo"}] :
                [{type:"User",name:"Sample-User"}]};
    };
    const result = await collectAttribution(config,read,login,{state:"complete",items:[center()]},
        {items:[rawTeam("old",date)],error:null},new Date(date));
    assert.equal(result.status,"confirmed");
    assert.equal(result.method,"direct");
    assert.equal(calls.length,2);
    assert.equal(result.evidence.license.state,"not_checked");
});

test("team assignments are collected for every team; licensing fallback only runs after a complete negative team check", async () => {
    const calls = [];
    const teams = [team("newer","2022-01-01T00:00:00Z"),team("older","2020-01-01T00:00:00Z")];
    const result = await collectAttribution(config,async path => {
        calls.push(path);
        const name = new URL(`https://example.test${path}`).searchParams.get("name");
        return membership("team",name,[center(name)]);
    },login,{state:"complete",items:[]},{items:teams,error:null});
    assert.equal(result.center.id,"older");
    assert.equal(calls.length,2);
});

test("license pagination counts unique users separately from records; saves only this user's organization candidates", async () => {
    const calls = [];
    const otherSeats = Array.from({length:99},(_,i) => ({assignee:{login:`user-${i}`},organization:{login:"unrelated-org"}}));
    const first = [{assignee:{login},organization:{login:"example-org"}},...otherSeats];
    const result = await collectAttribution(config,async path => {
        calls.push(path);
        if (path.includes("/seats?")) return {total_seats:100,
            seats:path.endsWith("page=1") ? first : [{assignee:{login},organization:{login:"example-org"}}]};
        return membership("organization","example-org",[center()]);
    },login,{state:"complete",items:[]},{items:[],error:null});
    assert.equal(result.status,"confirmed");
    assert.equal(result.method,"organization");
    assert.equal(calls.length,3);
    assert.deepEqual(result.evidence.license.organizations.map(item => item.name),["example-org"]);
    assert.ok(!JSON.stringify(result).includes("unrelated-org"));
    assert.match(calls[2],/resource_type=organization&name=example-org/);
});

test("missing membership, detail, seat access and partial pagination produce explicit gaps, not Enterprise Only", async t => {
    t.mock.method(console,"error",() => {});
    for (const read of [
        async () => {throw Object.assign(new Error("Denied"),{status:403});},
        async () => ({total_seats:2,seats:[{assignee:{login},organization:{login:"example-org"}}]}),
        async () => ({total_seats:0,seats:[{organization:{login:"example-org"}}]}),
    ]) {
        const result = await collectAttribution(config,read,login,{state:"complete",items:[]},{items:[],error:null});
        assert.equal(result.status,"unresolved");
        assert.equal(result.evidence.license.state,"unavailable");
    }
    const user = await loadUser(config,async path => {
        if (path.startsWith("/users/")) return {login,id:1,type:"User"};
        if (path.includes("/memberships?")) return membership("user","different-user");
        if (path.includes("/teams?")) return [];
        return {user:login,budgets:[],has_next_page:false};
    },login);
    assert.equal(user.attribution.status,"unresolved");
    assert.equal(user.effectiveStatus,"not_returned");
    const incomplete = await collectAttribution(config,async () => ({...center(),resources:[],has_next_page:true}),
        login,{state:"complete",items:[center()]},{items:[],error:null});
    assert.equal(incomplete.status,"unresolved");
    await assert.rejects(collectAttribution(config,async () => {throw Object.assign(new Error("Cleared"),{code:"cache_cleared"});},
        login,{state:"complete",items:[center()]},{items:[],error:null}),/Cleared/);
});

function setup(t) {
    const root = mkdtempSync(join(tmpdir(),"finops-attribution-"));
    const store = new SnapshotStore(join(root,"cache.sqlite"));
    const state = {calls:0,denied:false,now:new Date(date)};
    const read = async path => {
        state.calls++;
        if (path.startsWith("/users/")) return {login,id:1,type:"User"};
        if (path.includes("resource_type=user")) return membership("user",login,[center()]);
        if (path.includes("resource_type=team")) return membership("team","example-team",[]);
        if (path.includes("/teams?")) return [];
        if (path.includes("/budgets?")) return {user:login,budgets:[],has_next_page:false};
        if (state.denied) throw Object.assign(new Error("Denied"),{status:403});
        return {...center(),resources:[{type:"User",name:login}],has_next_page:false};
    };
    const options = {identity:async () => "account-one",clock:() => state.now,read};
    const cache = new OverviewCache(store,options);
    t.after(() => {store.close();rmSync(root,{recursive:true});});
    return {store,state,cache,options};
}

test("attribution persists with warm zero-call views; configuration refresh invalidates, user refresh recomputes and failures retain last confirmed", async t => {
    t.mock.method(console,"error",() => {});
    const {store,state,cache,options} = setup(t);
    const query = {resource:"user",id:login};
    const first = await cache.get(config,query);
    assert.equal(first.data.attribution.status,"confirmed");
    const count = state.calls;
    const restarted = new OverviewCache(store,{...options,read:async () => {assert.fail("Warm evidence must not query GitHub");}});
    assert.deepEqual((await restarted.get(config,query)).data.attribution,first.data.attribution);
    assert.equal(state.calls,count);
    await cache.get(config,{resource:"cost-center-detail",id:"center-one",refresh:true});
    const invalidated = await restarted.get(config,query);
    assert.equal(invalidated.data.attribution.status,"provisional");
    assert.ok(invalidated.data.attribution.invalidatedAt);
    assert.equal(invalidated.data.attribution.lastConfirmed.center.id,"center-one");
    assert.equal((await cache.get(config,{...query,refresh:true})).data.attribution.status,"confirmed");
    state.denied = true;
    state.now = new Date("2026-01-03T00:00:00Z");
    const failed = await cache.get(config,{...query,refresh:true});
    assert.equal(failed.data.attribution.status,"unresolved");
    assert.equal(failed.data.attribution.lastConfirmed.checkedAt,first.data.attribution.checkedAt);
    assert.equal(failed.data.attribution.lastConfirmed.center.id,"center-one");
    const status = await cache.status(config);
    await cache.clear(config,status.contextToken);
    assert.equal(await cache.get(config,{...query,cacheOnly:true}),null);
});

test("clearing while evidence is in flight fences out the attribution write", async t => {
    const {cache,store,options} = setup(t);
    let resume;
    let entered;
    const ready = new Promise(resolve => {entered = resolve;});
    cache.read = async path => {
        if (path.includes("/cost-centers/center-one?")) {
            entered();
            await new Promise(resolve => {resume = resolve;});
        }
        return options.read(path);
    };
    const pending = cache.get(config,{resource:"user",id:login});
    await ready;
    await cache.clear(config,(await cache.status(config)).contextToken);
    resume();
    await assert.rejects(pending,/cleared/);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM snapshots").get().n,0);
});

test("configuration refresh during an in-flight user read cannot publish confirmed stale attribution", async t => {
    const {cache,options} = setup(t);
    let resume;
    let entered;
    const ready = new Promise(resolve => {entered = resolve;});
    let paused = false;
    cache.read = async path => {
        if (path.includes("/cost-centers/center-one?") && !paused) {
            paused = true;
            entered();
            await new Promise(resolve => {resume = resolve;});
        }
        return options.read(path);
    };
    const pending = cache.get(config,{resource:"user",id:login});
    await ready;
    await cache.get(config,{resource:"cost-center-detail",id:"center-one",refresh:true});
    resume();
    assert.equal((await pending).data.attribution.status,"provisional");
    const persisted = await cache.get(config,{resource:"user",id:login});
    assert.ok(persisted.data.attribution.invalidatedAt);
    assert.equal(persisted.data.attribution.lastConfirmed,null);
});
