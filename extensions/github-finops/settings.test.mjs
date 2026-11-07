import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, writeFileSync, readFileSync, copyFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {execFileSync} from "node:child_process";
import {versionInfo, authSource, revealDatabase, loadConnection} from "./settings.mjs";
import {authMetadata, GitHubReadError, readRequest} from "./github.mjs";
import {OverviewCache, SnapshotStore, databasePath} from "./cache.mjs";
import {startServer} from "./server.mjs";

const config = {enterprise:"example-enterprise",host:"github.com"};
const now = new Date("2025-01-02T00:00:00Z");
function temporary(t) {
    const root = mkdtempSync(join(tmpdir(),"finops-settings-"));
    t.after(() => rmSync(root,{recursive:true}));
    return root;
}
function reader(scopes = ["repo","read:enterprise"]) {
    const calls = [];
    return {calls,read:async (path,host,onLimit,inspect,identity) => {
        calls.push(path);
        assert.equal(host,config.host);
        if (path === "/user") {inspect?.({scopes});return {login:"sample-user",id:12};}
        if (path === "/graphql") {
            assert.deepEqual(identity,{enterprise:"example-enterprise"});
            return {data:{enterprise:{name:"Example enterprise",slug:"example-enterprise"}}};
        }
        if (path.includes("/budgets?")) return {budgets:[],has_next_page:false};
        if (path.endsWith("/cost-centers")) return {costCenters:[]};
        if (path.includes("/ai_credit/usage?")) return {usageItems:[]};
        if (path.includes("/teams?")) return [];
        throw new Error("Unexpected request");
    }};
}
const diagnosticReader = source => (path,host,inspect,identity) => source.read(path,host,undefined,inspect,identity);

test("cache routes require explicit same-origin scoped confirmation and never clear on status reads", async t => {
    t.mock.method(console,"error",() => {});
    const actions = [];
    const controlCache = async (target,options = {}) => {
        assert.deepEqual(target,config);
        actions.push(options);
        if (options.action === "clear" && options.contextToken !== "fixture-context") throw new Error("Context changed; confirm again.");
        return options.action === "clear" ? {cleared:true} : {contextToken:"fixture-context",snapshots:[]};
    };
    const {server,url} = await startServer(config,async () => null,{controlCache});
    t.after(() => new Promise(resolve => server.close(resolve)));
    const origin = new URL(url).origin;
    assert.equal((await fetch(`${url}settings/cache/clear`)).status,404);
    assert.equal((await fetch(`${url}settings/cache`)).status,200);
    assert.equal(actions.length,1);
    assert.equal((await fetch(`${url}settings/cache/clear`,{method:"POST",body:'{"contextToken":"fixture-context"}'})).status,403);
    assert.equal(actions.length,1);
    const post = token => fetch(`${url}settings/cache/clear`,{method:"POST",headers:{origin},body:JSON.stringify({contextToken:token})});
    assert.equal((await post("old-context")).status,409);
    assert.deepEqual(await (await post("fixture-context")).json(),{cleared:true});
});

test("runtime version comes from VERSION and reports only the checkout's actual revision/status", async t => {
    const directory = temporary(t);
    writeFileSync(join(directory,"VERSION"),"1.2.3-beta.1\n");
    const calls = [];
    const result = await versionInfo({directory,run:async (command,args) => {
        calls.push([command,args]);
        return {stdout: args.includes("--show-toplevel") ? directory :
            args.includes("--short=12") ? "abcdef012345\n" : " M file\n"};
    }});
    assert.deepEqual(result,{version:"1.2.3-beta.1",revision:"abcdef012345",dirty:true});
    assert.equal(calls.length,3);
    assert.deepEqual(await versionInfo({directory,run:async () => {throw Object.assign(new Error("No git"),{code:128});}}),
        {version:"1.2.3-beta.1",revision:null,dirty:null});
    assert.deepEqual(await versionInfo({directory,run:async () => ({stdout:resolve(directory,"..")})}),
        {version:"1.2.3-beta.1",revision:null,dirty:null});
    await assert.rejects(versionInfo({directory,run:async () => {throw Object.assign(new Error("Git denied"),{code:"EACCES"});}}),/Git denied/);
    writeFileSync(join(directory,"VERSION"),"not-a-version");
    await assert.rejects(versionInfo({directory}),/version is invalid/);
});

test("npm version lifecycle synchronizes plugin/package/lock without embedding a development hash", t => {
    const directory = temporary(t);
    copyFileSync(new URL("../../scripts/sync-version.mjs",import.meta.url),join(directory,"sync-version.mjs"));
    writeFileSync(join(directory,"package.json"),JSON.stringify({name:"version-test",version:"0.1.0",scripts:{version:"node sync-version.mjs"}}));
    writeFileSync(join(directory,"plugin.json"),JSON.stringify({name:"version-test",version:"0.1.0"}));
    writeFileSync(join(directory,"package-lock.json"),JSON.stringify({name:"version-test",version:"0.1.0",lockfileVersion:3,packages:{"":{name:"version-test",version:"0.1.0"}}}));
    execFileSync("npm",["version","minor","--no-git-tag-version"],{cwd:directory,stdio:"pipe"});
    const read = name => JSON.parse(readFileSync(join(directory,name),"utf8"));
    assert.equal(read("package.json").version,"0.2.0");
    assert.equal(read("plugin.json").version,read("package.json").version);
    assert.equal(read("package-lock.json").version,read("package.json").version);
    assert.equal(read("package-lock.json").packages[""].version,read("package.json").version);
    assert.equal(readFileSync(join(directory,"VERSION"),"utf8").trim(),read("package.json").version);
    assert.equal(readFileSync(new URL("../../VERSION",import.meta.url),"utf8").trim(),
        JSON.parse(readFileSync(new URL("../../package.json",import.meta.url),"utf8")).version);
    for (const name of ["package.json","plugin.json","package-lock.json"]) {
        const production = JSON.parse(readFileSync(new URL(`../../${name}`,import.meta.url),"utf8"));
        assert.equal(production.version,JSON.parse(readFileSync(new URL("../../package.json",import.meta.url),"utf8")).version);
    }
});

test("reveals only the resolved configured database using argument arrays and surfaces failures", async () => {
    const calls = [];
    const path = resolve(tmpdir(),"a cache","cache; not a command.sqlite");
    const run = async (...args) => {calls.push(args);return {stdout:""};};
    assert.deepEqual(await revealDatabase(path,{platform:"darwin",run}),{opened:true});
    assert.deepEqual(calls[0].slice(0,2),["open",["-R",path]]);
    await revealDatabase(path,{platform:"linux",run});
    assert.deepEqual(calls[1].slice(0,2),["xdg-open",[resolve(tmpdir(),"a cache")]]);
    await revealDatabase(path,{platform:"win32",run});
    assert.deepEqual(calls[2].slice(0,2),["explorer.exe",[`/select,${path}`]]);
    await assert.rejects(revealDatabase(path,{platform:"unsupported",run}),/not supported/);
    await assert.rejects(revealDatabase(path,{platform:"darwin",run:async () => {throw new Error("private OS details");}}),
        error => /Could not open/.test(error.message) && !error.message.includes("private"));
    assert.ok(databasePath().endsWith("cache.sqlite"));
});

test("auth metadata excludes tokens and host-specific environment precedence matches gh", () => {
    assert.equal(authSource("github.com",{GH_TOKEN:"secret",GITHUB_TOKEN:"another"}),"GH_TOKEN environment override");
    assert.equal(authSource("github.com",{GITHUB_TOKEN:"secret"}),"GITHUB_TOKEN environment override");
    assert.equal(authSource("example.ghe.com",{GH_TOKEN:"secret"}),"GH_TOKEN environment override");
    assert.equal(authSource("ghe.example",{GH_TOKEN:"ignored",GH_ENTERPRISE_TOKEN:"secret"}),"GH_ENTERPRISE_TOKEN environment override (enterprise hosts)");
    assert.equal(authSource("github.com",{}),"Stored gh credentials");
    assert.deepEqual(authMetadata(new Map([["x-oauth-scopes","repo, read:enterprise"],["authorization","secret"]])),
        {scopes:["repo","read:enterprise"]});
    assert.deepEqual(authMetadata(new Map()),{scopes:null});
    assert.deepEqual(authMetadata(new Map([["x-oauth-scopes",""]])),{scopes:[]});
    assert.throws(() => authMetadata(new Map([["x-oauth-scopes","Bearer secret-token-123"]])),/invalid scope metadata/);
    const identity = readRequest("/graphql",{enterprise:"example-enterprise",query:"mutation { forbidden }"});
    assert.equal(identity.method,"POST");
    assert.deepEqual(identity.args,["graphql","--raw-field",
        "query=query($slug: String!) { enterprise(slug: $slug) { name slug } }","--raw-field","slug=example-enterprise"]);
    assert.throws(() => readRequest("/graphql",{enterprise:'"; mutation { forbidden }'}),/valid enterprise/);
    assert.deepEqual(readRequest("/user"),{method:"GET",args:["/user"]});
});

test("connection checks validate actual endpoint shapes and distinguish scopes from endpoint capabilities", async () => {
    const source = reader([]);
    const result = await loadConnection(config,diagnosticReader(source),now);
    assert.equal(result.readEnterpriseScope,"missing");
    assert.equal(result.name,"Example enterprise");
    assert.equal(result.login,"sample-user");
    assert.ok(result.checks.every(check => check.state === "accessible"));
    assert.equal(source.calls.length,6);
    assert.ok(source.calls.includes("/enterprises/example-enterprise/settings/billing/budgets?per_page=1&page=1"));
    assert.ok(source.calls.includes("/enterprises/example-enterprise/settings/billing/ai_credit/usage?year=2025&month=1"));
    assert.ok(source.calls.includes("/enterprises/example-enterprise/members/sample-user/teams?per_page=1&page=1"));
    const unknown = await loadConnection(config,diagnosticReader(reader(null)),now);
    assert.equal(unknown.readEnterpriseScope,"unknown");
    const statuses = [401,403,404,503];
    for (const status of statuses) {
        const source = reader(["admin:enterprise"]);
        const checked = await loadConnection(config,async (path,host,inspect,identity) => {
            if (path.includes("/teams?")) throw new GitHubReadError("Do not expose raw body",null,status);
            return source.read(path,host,undefined,inspect,identity);
        },now);
        const team = checked.checks.find(check => check.key === "enterprise_teams");
        assert.equal(checked.readEnterpriseScope,"present");
        assert.equal(team.state,({401:"unauthenticated",403:"forbidden",404:"unavailable",503:"unknown"})[status]);
        assert.ok(!JSON.stringify(checked).includes("Do not expose raw body"));
    }
    const unauthenticated = await loadConnection(config,async () => {throw new GitHubReadError("No account",null,401);},now);
    assert.equal(unauthenticated.login,null);
    assert.equal(unauthenticated.checks.at(-1).state,"not_checked");
    const malformed = await loadConnection(config,async () => ({login:"wrong/login",name:"Wrong",slug:"another-enterprise"}),now);
    assert.equal(malformed.name,null);
    assert.ok(malformed.checks.every(check => check.state !== "accessible"));
    const sourceWithQueryError = reader();
    const queryError = await loadConnection(config,async (path,host,inspect) => {
        if (path === "/graphql") return {data:{enterprise:null},errors:[{type:"INSUFFICIENT_SCOPES",message:"Raw hidden details"}]};
        return sourceWithQueryError.read(path,host,undefined,inspect);
    },now);
    assert.equal(queryError.checks.find(check => check.key === "enterprise").state,"missing_scope");
    assert.equal(queryError.checks.find(check => check.key === "enterprise").status,200);
    assert.ok(!JSON.stringify(queryError).includes("Raw hidden details"));
});

test("Settings warm reads never probe, persist across restart, isolate access and retain last success on failed checks", async t => {
    const path = join(temporary(t),"cache.sqlite");
    const store = new SnapshotStore(path);
    t.after(() => store.close());
    const source = reader();
    const state = {account:"one",clock:now,fail:false};
    const options = {identity:async () => state.account,clock:() => state.clock,read:async (...args) => {
        if (state.fail) throw new GitHubReadError("Denied",null,403);
        return source.read(...args);
    }};
    const cache = new OverviewCache(store,options);
    const request = {resource:"connection",cacheOnly:true};
    assert.equal(await cache.get(config,request),null);
    assert.equal(source.calls.length,0);
    const first = await cache.get(config,{resource:"connection",refresh:true});
    assert.equal(first.data.checks.length,6);
    assert.equal(source.calls.length,6);
    assert.equal((await cache.get(config,request)).cache.source,"cached");
    assert.equal(source.calls.length,6);
    const restartedStore = new SnapshotStore(path);
    t.after(() => restartedStore.close());
    const restarted = new OverviewCache(restartedStore,{...options,read:async () => assert.fail("No GitHub reads on restart")});
    assert.deepEqual((await restarted.get(config,request)).data,first.data);
    state.account = "two";
    assert.equal(await cache.get(config,request),null);
    state.account = "one";
    assert.equal(await cache.get({...config,host:"example.test"},request),null);
    assert.equal(await cache.get({...config,enterprise:"another-enterprise"},request),null);
    state.fail = true;state.clock = new Date("2025-01-03T00:00:00Z");
    const failed = await cache.get(config,{resource:"connection",refresh:true});
    assert.equal(failed.data.name,first.data.name);
    assert.equal(failed.data.nameAt,first.data.nameAt);
    assert.equal(failed.data.login,first.data.login);
    assert.equal(failed.data.checks[0].state,"forbidden");
    assert.equal(failed.data.checks[0].lastAccessibleAt,first.data.checkedAt);
    assert.equal(failed.data.readEnterpriseScope,"unknown");
    assert.equal((await cache.get(config,request)).data.checks[0].state,"forbidden");
});

test("connection probes honor persisted cooldown without extra reads and never swallow local cache failures", async t => {
    const store = new SnapshotStore(join(temporary(t),"cache.sqlite"));
    t.after(() => store.close());
    let calls = 0;
    const cache = new OverviewCache(store,{identity:async () => "one",clock:() => now,read:async () => {
        calls++;
        throw new GitHubReadError("Limited","2025-01-02T00:02:00Z",429);
    }});
    const result = await cache.get(config,{resource:"connection",refresh:true});
    assert.equal(calls,1);
    assert.equal(result.cache.retryAt,"2025-01-02T00:02:00Z");
    assert.ok(result.data.checks.filter(check => check.state !== "not_checked").every(check => check.state === "rate_limited"));
    await cache.get(config,{resource:"connection",refresh:true});
    assert.equal(calls,1);
    await assert.rejects(loadConnection(config,async () => {throw Object.assign(new Error("SQLite failed"),{code:"local_cache_error"});}),/SQLite failed/);
});

test("Settings routes expose local metadata during auth errors and reveal only server-selected paths with same-origin POST", async t => {
    t.mock.method(console,"error",() => {});
    const reveals = [];
    const loads = [];
    const database = resolve(tmpdir(),"configured-cache.sqlite");
    const {server,url} = await startServer(config,async (input,options) => {
        loads.push(options);
        throw new GitHubReadError("Could not identify active gh credentials.");
    },{version:async () => ({version:"0.1.0",revision:null,dirty:null}),dbPath:() => database,
        reveal:async path => {reveals.push(path);return {opened:true};}});
    t.after(() => new Promise(resolve => server.close(resolve)));
    const result = await (await fetch(`${url}settings`)).json();
    assert.equal(result.database,database);
    assert.equal(result.target.enterprise,config.enterprise);
    assert.equal(result.connection,null);
    assert.match(result.connectionError,/credentials/);
    assert.deepEqual(loads,[{resource:"connection",refresh:false,cacheOnly:true}]);
    await fetch(`${url}settings?refresh=1`);
    assert.deepEqual(loads[1],{resource:"connection",refresh:true,cacheOnly:false});
    assert.equal((await fetch(`${url}settings/reveal`,{method:"POST"})).status,403);
    assert.equal((await fetch(`${url}settings/reveal`,{method:"POST",headers:{origin:"https://other.example"}})).status,403);
    assert.equal((await fetch(`${url}settings/reveal?path=arbitrary`,{method:"POST",headers:{origin:new URL(url).origin}})).status,405);
    const opened = await fetch(`${url}settings/reveal`,{method:"POST",headers:{origin:new URL(url).origin},body:'{"path":"arbitrary"}'});
    assert.equal(opened.status,200);
    assert.deepEqual(reveals,[database]);
});
