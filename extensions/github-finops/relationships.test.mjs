import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFileSync} from "node:child_process";
import {SnapshotStore, OverviewCache} from "./cache.mjs";
import {GitHubReadError} from "./github.mjs";

const center = (id = "center-one", name = "Engineering") => ({id,name,resources:[]});
const budget = (id = "budget-one", entity = "center-one", scope = "cost_center") =>
    ({id,entity,scope,product:"actions",type:"ProductPricing",amount:80,consumed:null});
const snapshot = (kind, data, second = 1) => ({kind,data,fetchedAt:`2025-01-01T00:00:${String(second).padStart(2,"0")}.000Z`});
function setup(t) {
    const directory = mkdtempSync(join(tmpdir(),"finops-relations-"));
    const path = join(directory,"cache.sqlite");
    const store = new SnapshotStore(path);
    t.after(() => {store.close();rmSync(directory,{recursive:true});});
    const put = (key, kind, data, second, namespace = "scope-one") =>
        store.put(key,snapshot(kind,data,second),null,namespace);
    return {store,path,put};
}

test("persists multiple budget types and both cost-center scopes across a process restart", t => {
    const {store,path,put} = setup(t);
    put("centers","cost-centers",[center()],1);
    put("budgets","budgets",[budget(),{...budget("budget-two","center-one","multi_user_cost_center"),product:"ai_credits"}],2);
    const result = store.relationships("scope-one");
    assert.equal(result.links.length,2);
    assert.ok(result.links.every(link => link.matchedBy === "id"));
    const script = `
        import {SnapshotStore} from ${JSON.stringify(new URL("./cache.mjs",import.meta.url).href)};
        const store = new SnapshotStore(${JSON.stringify(path)});
        console.log(JSON.stringify(store.relationships("scope-one")));
        store.close();
    `;
    const restarted = JSON.parse(execFileSync(process.execPath,["--input-type=module","-e",script],{encoding:"utf8"}));
    assert.deepEqual(restarted,JSON.parse(JSON.stringify(result)));
});

test("name matches require a complete center list and exact uniqueness; ambiguity is unresolved", t => {
    const {store,put} = setup(t);
    put("detail","cost-center-detail",center(),1);
    put("budgets","budgets",[budget("budget-one","Engineering"),budget("budget-two","engineering")],2);
    assert.equal(store.relationships("scope-one").links.length,0);
    assert.equal(store.relationships("scope-one").unresolved[0].reason,"centers_not_loaded");
    put("centers","cost-centers",[center()],3);
    assert.equal(store.relationships("scope-one").links[0].matchedBy,"exact_unique_name");
    assert.equal(store.relationships("scope-one").unresolved[0].budgetId,"budget-two");
    put("centers","cost-centers",[center(),center("center-two","Engineering")],4);
    assert.equal(store.relationships("scope-one").links.length,0);
    assert.equal(store.relationships("scope-one").unresolved[0].reason,"ambiguous_name");
});

test("renames, reassignment, scope changes and complete removals reconcile persisted links", t => {
    const {store,put} = setup(t);
    put("centers","cost-centers",[center(),center("center-two","Finance")],1);
    put("budgets","budgets",[budget("budget-one","Engineering")],2);
    put("centers","cost-centers",[center("center-one","Platform"),center("center-two","Finance")],3);
    assert.equal(store.relationships("scope-one").links.length,0);
    put("centers","cost-centers",[center("center-one","Platform"),center("center-two","Accounting")],3);
    assert.equal(store.relationships("scope-one").centers.find(center => center.id === "center-two").name,"Accounting");
    put("centers","cost-centers",[center("center-one","Platform"),center("center-two","Finance")],3);
    put("detail","budget-detail",budget("budget-one","Finance"),4);
    assert.equal(store.relationships("scope-one").links[0].centerId,"center-two");
    put("detail","budget-detail",budget("budget-one","center-one"),5);
    assert.equal(store.relationships("scope-one").links[0].matchedBy,"id");
    put("detail","budget-detail",budget("budget-one","center-one","multi_user_customer"),6);
    assert.equal(store.relationships("scope-one").links.length,0);
    put("detail","budget-detail",budget("budget-one","center-one"),7);
    put("centers","cost-centers",[],8);
    assert.equal(store.relationships("scope-one").links.length,0);
    put("centers","cost-centers",[center()],9);
    assert.equal(store.relationships("scope-one").links.length,1);
    put("budgets","budgets",[],10);
    assert.equal(store.relationships("scope-one").budgets.length,0);
    store.index("scope-one","old-detail",snapshot("budget-detail",budget(),2));
    assert.equal(store.relationships("scope-one").links.length,0);
    assert.equal(store.relationships("scope-one").budgets.length,0);
});

test("ID matches take precedence over names and associations never cross cache namespaces", t => {
    const {store,put} = setup(t);
    put("centers","cost-centers",[center(),center("center-two","center-one")],1);
    put("budgets","budgets",[budget()],2);
    assert.equal(store.relationships("scope-one").links[0].centerId,"center-one");
    put("other-centers","cost-centers",[center("center-one","Other")],1,"scope-two");
    assert.equal(store.relationships("scope-two").budgets.length,0);
    assert.equal(store.relationships("scope-two").links.length,0);
    assert.equal(store.relationships("scope-one").centers.length,2);
});

test("incomplete lists cannot establish name uniqueness or erase last-good relationships", t => {
    const {store,put} = setup(t);
    store.put("partial",{...snapshot("cost-centers",[center()],1),complete:false},null,"scope-one");
    put("budgets","budgets",[budget("budget-one","Engineering")],2);
    assert.equal(store.relationships("scope-one").links.length,0);
    assert.equal(store.relationships("scope-one").lists.centers,null);
    put("centers","cost-centers",[center()],3);
    assert.equal(store.relationships("scope-one").links.length,1);
    store.put("centers",{...snapshot("cost-centers",[],4),complete:false},null,"scope-one");
    store.put("budgets",{...snapshot("budgets",[],5),complete:false},null,"scope-one");
    assert.equal(store.relationships("scope-one").links.length,1);
    assert.equal(store.relationships("scope-one").budgets.length,1);
});

test("snapshot and relationship writes roll back together on SQLite failure", t => {
    const {store,put} = setup(t);
    put("centers","cost-centers",[center()],1);
    put("budgets","budgets",[budget()],2);
    store.db.exec("CREATE TRIGGER deny_relation BEFORE INSERT ON budget_cost_centers BEGIN SELECT RAISE(FAIL, 'denied'); END;");
    assert.throws(() => put("centers","cost-centers",[center("center-one","Renamed")],3),/local SQLite cache/);
    assert.equal(store.get("centers").data[0].name,"Engineering");
    assert.equal(store.relationships("scope-one").centers[0].name,"Engineering");
    assert.equal(store.relationships("scope-one").links.length,1);
});

test("warm reads backfill legacy snapshots without API calls and retain links on limited refresh", async t => {
    t.mock.method(console,"error",()=>{});
    const {store} = setup(t);
    let calls = 0;
    let limited = false;
    const options = {identity:async () => "account-one",clock:()=>new Date("2025-01-01"),
        read:async path => {
            calls++;
            if (limited) throw new GitHubReadError("Rate limited","2025-01-01T00:10:00Z");
            return path.includes("/cost-centers") ? {costCenters:[center()]} : {
                budgets:[{id:"budget-one",budget_scope:"cost_center",budget_entity_name:"Engineering",
                    budget_type:"ProductPricing",budget_product_sku:"actions",budget_amount:80}],has_next_page:false};
        }};
    const input = {enterprise:"example-enterprise"};
    const cache = new OverviewCache(store,options);
    await cache.get(input,{resource:"cost-centers"});
    await cache.get(input,{resource:"budgets"});
    store.db.exec("DELETE FROM relationship_sources; DELETE FROM relationship_centers; DELETE FROM relationship_budgets; DELETE FROM budget_cost_centers;");
    const restarted = new OverviewCache(store,options);
    const warm = await restarted.get(input,{resource:"budgets"});
    assert.equal(calls,2);
    assert.equal(warm.relationships.links[0].matchedBy,"exact_unique_name");
    limited = true;
    const failed = await restarted.get(input,{resource:"budgets",refresh:true});
    assert.equal(failed.relationships.links.length,1);
    assert.ok(failed.relationships.lists.budgets.error);
    const before = calls;
    await restarted.get(input,{resource:"cost-centers",refresh:true});
    assert.equal(calls,before);
    limited = false;
    const later = {...options,clock:()=>new Date("2025-01-01T00:20:00Z")};
    for (const [otherInput, identity] of [
        [{enterprise:"another-enterprise"}, "account-one"],
        [{...input,host:"another.example"}, "account-one"],
        [input, "account-two"],
    ]) {
        const isolated = await new OverviewCache(store,{...later,identity:async () => identity}).get(otherInput,{resource:"budgets"});
        assert.equal(isolated.relationships.links.length,0);
        assert.equal(isolated.relationships.lists.centers,null);
    }
});
