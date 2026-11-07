import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SnapshotStore, OverviewCache } from "./cache.mjs";
import { GitHubReadError } from "./github.mjs";
import {createHash} from "node:crypto";

const input = { enterprise: "example-enterprise" };

function setup(t) {
    const root = mkdtempSync(join(tmpdir(), "finops-cache-"));
    const path = join(root, "cache.sqlite");
    const store = new SnapshotStore(path);
    const state = { calls: 0, account: "account-one", now: new Date("2025-01-02T00:00:00Z"), failure: null, spendingFailure: false };
    const read = async url => {
        state.calls++;
        if (state.failure) throw state.failure;
        if (url.includes("/ai_credit/usage")) {
            if (state.spendingFailure) throw new Error("Spending unavailable");
            const params = new URL(`https://example.test${url}`).searchParams;
            return { timePeriod: { year: Number(params.get("year")), month: Number(params.get("month")) },
                usageItems: [{ unitType: "ai-credits", grossAmount: 2, discountAmount: 1, netAmount: 1 }] };
        }
        return { budgets: [], has_next_page: false };
    };
    const options = { identity: async () => state.account, clock: () => state.now, read };
    const cache = new OverviewCache(store, options);
    t.after(() => { store.close(); rmSync(root, { recursive: true }); });
    return { store, cache, state, path, options };
}

test("cold start fetches once; concurrent and repeated warm opens make zero additional GitHub calls", async t => {
    const { cache, state } = setup(t);
    const [first, second] = await Promise.all([cache.get(input), cache.get(input)]);
    assert.equal(state.calls, 3);
    assert.equal(first.cache.source, "live");
    assert.equal(second.spending.net, 1);
    for (let i = 0; i < 3; i++) {
        assert.equal((await cache.get(input)).cache.source, "cached");
    }
    assert.equal(state.calls, 3);
});

test("universal user states are explicit, durable, namespace/month isolated and retain last-good pages on failure", async t => {
    t.mock.method(console, "error", () => {});
    const {cache, store, state, options} = setup(t);
    let calls = 0;
    let fail = false;
    options.read = async path => {
        calls++;
        if (!path.includes("user-states")) return {budgets:[{id:"universal",budget_type:"BundlePricing",
            budget_scope:"multi_user_customer",budget_product_sku:"ai_credits",budget_amount:100}],has_next_page:false};
        if (fail && path.includes("page=2&")) throw new GitHubReadError("State read denied", null, 403);
        return {user_states:[{user:path.includes("page=1&")?"octocat":"second-user",consumed_amount:90,target_amount:100}],
            has_next_page:path.includes("page=1&"),total_count:2};
    };
    cache.read = options.read;
    const resource = "universal-users";
    assert.equal(await cache.get(input, {resource,cacheOnly:true}), null);
    assert.equal(calls, 0);
    const live = await cache.get(input,{resource,refresh:true});
    assert.equal(calls, 3);
    assert.equal(live.data.states.length, 2);
    const restarted = new OverviewCache(store, options);
    assert.equal((await restarted.get(input,{resource,cacheOnly:true})).cache.source, "cached");
    assert.equal(calls, 3);
    fail = true;
    const failed = await cache.get(input,{resource,refresh:true});
    assert.deepEqual(failed.data, JSON.parse(JSON.stringify(live.data)));
    assert.equal(failed.cache.fetchedAt, live.cache.fetchedAt);
    assert.equal(failed.cache.error, "State read denied");
    assert.equal((await cache.get(input,{resource,cacheOnly:true})).cache.error, "State read denied");
    state.account = "another-account";
    assert.equal(await cache.get(input,{resource,cacheOnly:true}), null);
    state.account = "account-one";
    for (const target of [{enterprise:"other-enterprise"},{...input,host:"other.example"}]) {
        assert.equal(await cache.get(target,{resource,cacheOnly:true}), null);
    }
    state.now = new Date("2025-02-01T00:00:00Z");
    assert.equal(await cache.get(input,{resource,cacheOnly:true}), null);
    assert.equal(calls, 6);
});

test("universal user-state rate limits retain snapshots and block subsequent billing reads", async t => {
    t.mock.method(console,"error",()=>{});
    const {cache,state} = setup(t);
    cache.read = async path => path.includes("user-states")
        ? {user_states:[],has_next_page:false,total_count:0}
        : {budgets:[{id:"universal",budget_scope:"multi_user_customer",budget_type:"BundlePricing",
            budget_product_sku:"ai_credits",budget_amount:100}],has_next_page:false};
    const options = {resource:"universal-users",refresh:true};
    await cache.get(input,options);
    const retryAt = "2025-01-02T00:05:00Z";
    cache.read = async () => {throw new GitHubReadError("Rate limited",retryAt,429);};
    const failed = await cache.get(input,options);
    assert.equal(failed.cache.retryAt,retryAt);
    cache.read = async () => {throw new Error("Cooldown must prevent network");};
    const warm = await cache.get(input,options);
    assert.equal(warm.cache.retryAt,retryAt);
    assert.equal(warm.data.states.length,0);
    assert.equal(state.now.toISOString(),"2025-01-02T00:00:00.000Z");
});

test("legacy overview JSON and new universal state snapshots coexist without changing SQL schema", async t => {
    const {cache,store,state} = setup(t);
    cache.load = async () => ({budgets:[{scope:"multi_user_customer",configured:true,amount:50,consumed:null}],
        spending:{status:"unavailable",message:"No rows",period:{year:2025,month:1}},updatedAt:state.now.toISOString()});
    await cache.get(input);
    const legacy = await cache.get(input,{cacheOnly:true});
    assert.equal(legacy.budgets[0].product,undefined);
    assert.equal(legacy.budgets[0].amount,50);
    assert.equal(await cache.get(input,{resource:"universal-users",cacheOnly:true}),null);
    const version = store.db.prepare("PRAGMA user_version").get().user_version;
    await cache.get(input,{resource:"universal-users",refresh:true});
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version,version);
    assert.equal((await cache.get(input,{cacheOnly:true})).budgets[0].amount,50);
});

test("snapshots persist across a new Node process without API reads", async t => {
    const { cache, path } = setup(t);
    await cache.get(input);
    const script = `
      import {SnapshotStore, OverviewCache} from ${JSON.stringify(new URL("./cache.mjs", import.meta.url).href)};
      const store = new SnapshotStore(${JSON.stringify(path)});
      const cache = new OverviewCache(store, {
        identity: async () => "account-one",
        clock: () => new Date("2025-01-02T00:00:00Z"),
        read: async () => { throw new Error("A warm restart must not query GitHub"); }
      });
      console.log(JSON.stringify(await cache.get({enterprise:"example-enterprise"})));
      store.close();
    `;
    const persisted = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }));
    assert.equal(persisted.cache.source, "cached");
    assert.equal(persisted.spending.net, 1);
});

test("isolates account, enterprise, host and UTC billing month", async t => {
    const { cache, state } = setup(t);
    await cache.get(input);
    state.account = "account-two";
    assert.equal((await cache.get(input)).cache.source, "live");
    state.account = "account-one";
    assert.equal((await cache.get(input)).cache.source, "cached");
    assert.equal((await cache.get({ enterprise: "another-enterprise" })).cache.source, "live");
    assert.equal((await cache.get({ ...input, host: "another.example" })).cache.source, "live");
    state.now = new Date("2025-02-01T00:00:00Z");
    const rolled = await cache.get(input);
    assert.equal(rolled.cache.source, "live");
    assert.equal(rolled.spending.period.month, 2);
    assert.equal(state.calls, 15);
});

test("failed live refresh preserves successful data and reports stale/error status on later opens", async t => {
    t.mock.method(console, "error", () => {});
    const { cache, state } = setup(t);
    const first = await cache.get(input);
    state.failure = new Error("Offline");
    const failed = await cache.get(input, { refresh: true });
    assert.equal(failed.spending.net, first.spending.net);
    assert.equal(failed.cache.spendingAt, first.cache.spendingAt);
    assert.equal(failed.cache.stale, true);
    assert.match(failed.cache.error, /refresh failed/);
    const calls = state.calls;
    const warm = await cache.get(input);
    assert.equal(warm.cache.error, failed.cache.error);
    assert.equal(state.calls, calls);
});

test("a partial refresh does not overwrite previously successful spending", async t => {
    t.mock.method(console, "error", () => {});
    const { cache, state } = setup(t);
    const first = await cache.get(input);
    state.spendingFailure = true;
    const partial = await cache.get(input, { refresh: true });
    assert.equal(partial.spending.status, "available");
    assert.equal(partial.spending.net, 1);
    assert.equal(partial.cache.spendingAt, first.cache.spendingAt);
    assert.equal(partial.cache.source, "live");
    assert.equal(partial.cache.stale, true);
    assert.match(partial.cache.error, /current AI spending/);
});

test("cold-start budgets remain cached even when spending is inaccessible", async t => {
    t.mock.method(console, "error", () => {});
    const { cache, state } = setup(t);
    state.spendingFailure = true;
    const first = await cache.get(input);
    assert.equal(first.spending.status, "error");
    const calls = state.calls;
    const warm = await cache.get(input);
    assert.equal(warm.cache.source, "cached");
    assert.equal(warm.budgets.length, 2);
    assert.equal(warm.cache.spendingAt, null);
    assert.equal(state.calls, calls);
});

test("cached data is not accessible without the matching local credential context", async t => {
    const { cache, store, options, state } = setup(t);
    await cache.get(input);
    const signedOut = new OverviewCache(store, {
        ...options, identity: async () => { throw new Error("Not signed in"); },
    });
    await assert.rejects(signedOut.get(input), /Not signed in/);
    assert.equal(state.calls, 3);
});

test("rate-limit cooldown persists and blocks repeated refreshes including month-rollover misses", async t => {
    t.mock.method(console, "error", () => {});
    const { cache, store, state, options } = setup(t);
    await cache.get(input);
    const retryAt = "2025-02-01T00:10:00Z";
    state.failure = new GitHubReadError("Rate limited", retryAt);
    const limited = await cache.get(input, { refresh: true });
    assert.equal(limited.cache.retryAt, retryAt);
    const calls = state.calls;
    const restarted = new OverviewCache(store, options);
    await restarted.get(input, { refresh: true });
    assert.equal(state.calls, calls);
    state.now = new Date("2025-02-01T00:00:00Z");
    await assert.rejects(restarted.get(input), /No snapshot/);
    assert.equal(state.calls, calls);
    state.now = new Date("2025-02-01T00:11:00Z");
    state.failure = null;
    assert.equal((await restarted.get(input)).cache.source, "live");
    assert.equal(state.calls, calls + 3);
});

test("cold failure is explicit; SQLite read/write failures never bypass the cache", async t => {
    t.mock.method(console, "error", () => {});
    const { cache, state, store } = setup(t);
    state.failure = new Error("Unavailable");
    await assert.rejects(cache.get(input), /Unavailable/);
    state.failure = null;
    store.db.exec("CREATE TRIGGER deny_snapshot BEFORE INSERT ON snapshots BEGIN SELECT RAISE(FAIL, 'write denied'); END;");
    await assert.rejects(cache.get(input), /local SQLite cache/);
    const calls = state.calls;
    store.db.exec("DROP TABLE snapshots");
    await assert.rejects(cache.get(input), /local SQLite cache/);
    assert.equal(state.calls, calls);
});

test("list/detail caches reuse durable snapshots and retain data/errors independently", async t => {
    t.mock.method(console, "error", () => {});
    const {store, options, state} = setup(t);
    let calls = 0;
    let fail = false;
    const cache = new OverviewCache(store, {...options, read: async path => {
        calls++;
        if (fail) throw new Error("Offline");
        const center = {id:"center-one",name:"Engineering",state:"active",resources:[],ai_credit_pool_enabled:false};
        return path.endsWith("/cost-centers") ? {costCenters:[center]} : {...center,has_next_page:false};
    }});
    await cache.get(input, {resource:"cost-centers"});
    await cache.get(input, {resource:"cost-center-detail",id:"center-one"});
    const firstCalls = calls;
    const restarted = new OverviewCache(store, {...options, read: async () => {throw new Error("Unexpected API call");}});
    assert.equal((await restarted.get(input,{resource:"cost-centers"})).cache.source,"cached");
    assert.equal((await restarted.get(input,{resource:"cost-center-detail",id:"center-one"})).data.name,"Engineering");
    assert.equal(calls,firstCalls);
    state.now = new Date("2025-02-01T00:00:00Z");
    assert.equal((await cache.get(input,{resource:"cost-centers"})).cache.source,"cached");
    fail = true;
    const retained = await cache.get(input,{resource:"cost-center-detail",id:"center-one",refresh:true});
    assert.equal(retained.data.name,"Engineering");
    assert.match(retained.cache.error,/refresh failed/);
    state.account = "account-two";
    await assert.rejects(cache.get(input,{resource:"cost-centers"}),/Offline/);
});

test("budget list/detail snapshots persist, isolate access and retain data through failures and cooldown", async t => {
    t.mock.method(console, "error", () => {});
    const {store, options, state} = setup(t);
    let calls = 0;
    let failure;
    const cache = new OverviewCache(store, {...options, read: async path => {
        calls++;
        if (failure) throw failure;
        const budget = {id:"budget-one",budget_scope:"enterprise",budget_type:"ProductPricing",
            budget_product_sku:"actions",budget_amount:80,consumed_amount:5};
        return path.includes("?") ? {budgets:[budget],has_next_page:false} : budget;
    }});
    await cache.get(input,{resource:"budgets"});
    await cache.get(input,{resource:"budget-detail",id:"budget-one"});
    const restarted = new OverviewCache(store,{...options,read:async () => {throw new Error("Unexpected API call");}});
    assert.equal((await restarted.get(input,{resource:"budgets"})).data[0].amount,80);
    assert.equal((await restarted.get(input,{resource:"budget-detail",id:"budget-one"})).data.consumed,5);
    assert.equal(calls,2);
    failure = new Error("Offline");
    const failed = await cache.get(input,{resource:"budgets",refresh:true});
    assert.equal(failed.data.length,1);
    assert.match(failed.cache.error,/refresh failed/);
    failure = new GitHubReadError("Rate limited","2025-01-02T00:10:00Z");
    const limited = await cache.get(input,{resource:"budget-detail",id:"budget-one",refresh:true});
    assert.equal(limited.data.amount,80);
    const before = calls;
    await cache.get(input,{resource:"budgets",refresh:true});
    assert.equal(calls,before);
    state.account = "other-account";
    await assert.rejects(cache.get(input,{resource:"budgets"}),/Rate limited/);
    state.account = "account-one";
    await assert.rejects(cache.get({enterprise:"another-enterprise"},{resource:"budgets"}),/No snapshot/);
});

test("cache status is local and clearing isolates tenants, accounts and derived relationships", async t => {
    const {cache,store,state,options,path} = setup(t);
    await cache.get(input);
    const scope = await cache.scope(input);
    store.put("fixture-center",{kind:"cost-centers",complete:true,data:[{id:"center-one",name:"Engineering"}],fetchedAt:state.now.toISOString()},null,scope.namespace);
    store.put("fixture-budget",{kind:"budgets",data:[{id:"budget-one",scope:"cost_center",entity:"Engineering"}],fetchedAt:state.now.toISOString()},null,scope.namespace);
    assert.equal(store.relationships(scope.namespace).links.length,1);
    await cache.get({enterprise:"another-enterprise"});
    state.account = "account-two";
    await cache.get(input);
    const calls = state.calls;
    state.account = "account-one";
    const status = await cache.status(input);
    assert.equal(status.snapshots.find(row => row.resource === "overview").count,1);
    assert.equal(status.refreshing,false);
    assert.equal(state.calls,calls);
    state.account = "account-two";
    await assert.rejects(cache.clear(input,status.contextToken),/context changed/);
    state.account = "account-one";
    await cache.clear(input,status.contextToken);
    assert.deepEqual((await cache.status(input)).snapshots,[]);
    assert.equal(store.relationships(scope.namespace).links.length,0);
    const restartedStore = new SnapshotStore(path);
    try {
        const restarted = new OverviewCache(restartedStore,options);
        assert.equal(await restarted.get(input,{cacheOnly:true}),null);
        assert.equal((await restarted.get({enterprise:"another-enterprise"},{cacheOnly:true})).cache.source,"cached");
        state.account = "account-two";
        assert.equal((await restarted.get(input,{cacheOnly:true})).cache.source,"cached");
        assert.equal(state.calls,calls);
    } finally {restartedStore.close();}
});

test("clear fences in-flight results and errors without deduplicating new requests against old ones", async t => {
    const {store,options} = setup(t);
    for (const fail of [false,true]) {
        let hold = false;
        let release;
        const cache = new OverviewCache(store,{...options,load:async () => {
            if (hold) await new Promise((resolve,reject) => {release = () => fail ? reject(new Error("Old failure")) : resolve();});
            return {budgets:[],updatedAt:options.clock().toISOString(),spending:{status:"unavailable",message:"Fixture"}};
        }});
        await cache.get(input);
        hold = true;
        const old = cache.get(input,{refresh:true});
        const rejected = assert.rejects(old,error => error.code === "cache_cleared");
        while (!release) await new Promise(resolve => setImmediate(resolve));
        const status = await cache.status(input);
        assert.equal(status.refreshing,true);
        await cache.clear(input,status.contextToken);
        hold = false;
        const current = await cache.get(input);
        assert.equal(current.cache.source,"live");
        assert.equal((await cache.status(input)).refreshing,false);
        release();
        await rejected;
        assert.equal((await cache.get(input,{cacheOnly:true})).cache.source,"cached");
    }
});

test("legacy unclassified snapshots are invalidated across restart without deleting another context", async t => {
    const {cache,store,state,options} = setup(t);
    await cache.get(input);
    const {context} = await cache.scope(input);
    const key = createHash("sha256").update(JSON.stringify(["github.com","example-enterprise",context,"user","sample-user",2025,1])).digest("hex");
    store.db.prepare("INSERT INTO snapshots (cache_key,payload) VALUES (?,?)").run(key,
        JSON.stringify({kind:"user",data:{id:123},fetchedAt:state.now.toISOString()}));
    const status = await cache.status(input);
    await cache.clear(input,status.contextToken);
    const restarted = new OverviewCache(store,options);
    assert.equal(await restarted.get(input,{resource:"user",id:"sample-user",cacheOnly:true}),null);
    assert.equal(state.calls,3);
    assert.ok(store.db.prepare("SELECT 1 FROM snapshots WHERE cache_key = ?").get(key));
    await assert.rejects(cache.clear(input,status.contextToken),/context changed/);
});

test("clearing preserves durable rate-limit cooldown and does not request live data", async t => {
    t.mock.method(console,"error",() => {});
    const {cache,state,store,options} = setup(t);
    await cache.get(input);
    state.failure = new GitHubReadError("Rate limited","2025-01-02T00:10:00Z");
    await cache.get(input,{refresh:true});
    const status = await cache.status(input);
    assert.equal(status.snapshots[0].errors,1);
    const calls = state.calls;
    await cache.clear(input,status.contextToken);
    const restarted = new OverviewCache(store,options);
    assert.equal((await restarted.status(input)).retryAt,status.retryAt);
    await assert.rejects(restarted.get(input,{refresh:true}),/cooldown/);
    assert.equal(state.calls,calls);
});

test("upgrades the legacy snapshot schema without losing saved data", t => {
    const {store,path,state} = setup(t);
    store.db.exec("PRAGMA user_version = 0; DROP TABLE snapshots; CREATE TABLE snapshots (cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, last_error TEXT)");
    store.db.prepare("INSERT INTO snapshots VALUES (?,?,NULL)").run("legacy",
        JSON.stringify({kind:"budgets",data:[],fetchedAt:state.now.toISOString()}));
    const migrated = new SnapshotStore(path);
    try {
        assert.deepEqual(migrated.get("legacy","fixture-context","budgets",0).data,[]);
        assert.equal(migrated.inventory("fixture-context")[0].count,1);
        migrated.clear("fixture-context",0);
        assert.equal(migrated.get("legacy"),null);
    } finally {migrated.close();}
});

test("attention inputs stay cache-only and expose known detail consumption alongside the saved list", async t => {
    const {store,options} = setup(t);
    let calls = 0;
    const budget = {id:"sample-budget",budget_scope:"enterprise",budget_type:"BundlePricing",budget_product_sku:"ai_credits",budget_amount:100};
    const cache = new OverviewCache(store,{...options,read:async path => {
        calls++;
        return path.includes("?") ? {budgets:[budget],has_next_page:false} : {...budget,consumed_amount:95};
    }});
    assert.equal(await cache.get(input,{resource:"budgets",cacheOnly:true}),null);
    assert.equal(calls,0);
    await cache.get(input,{resource:"budgets"});
    await cache.get(input,{resource:"budget-detail",id:"sample-budget"});
    const saved = await cache.get(input,{resource:"budgets",cacheOnly:true});
    assert.equal(saved.data[0].consumed,null);
    assert.equal(saved.relationships.budgets[0].consumed,95);
    assert.equal(calls,2);
});

test("budget consumption snapshots rotate with UTC billing month", async t => {
    const {store, options, state} = setup(t);
    let calls = 0;
    const cache = new OverviewCache(store,{...options,read:async path => {
        calls++;
        const budget = {id:"budget-one",budget_scope:"enterprise",budget_type:"ProductPricing",
            budget_product_sku:"actions",budget_amount:80};
        return path.includes("?") ? {budgets:[budget],has_next_page:false} : budget;
    }});
    for (const resource of ["budgets","budget-detail"]) {
        await cache.get(input,{resource,id:resource === "budget-detail" ? "budget-one" : undefined});
    }
    state.now = new Date("2025-02-01T00:00:00Z");
    for (const resource of ["budgets","budget-detail"]) {
        assert.equal((await cache.get(input,{resource,id:resource === "budget-detail" ? "budget-one" : undefined})).cache.source,"live");
    }
    assert.equal(calls,4);
});
