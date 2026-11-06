import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, existsSync, statSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {parseEnterpriseUrl, readTarget, saveTarget, cliStatus, canLoadOverview} from "./onboarding.mjs";
import {cachedOverview} from "./cache.mjs";
import {startServer} from "./server.mjs";

const config = {enterprise: "example-enterprise", host: "github.com"};
const cli = async () => ({installed: true, version: "gh version fixture", error: null});
const connection = (source = "live") => ({data: {checks: [
    {key: "authentication", state: "accessible"}, {key: "budgets", state: "accessible"},
    {key: "enterprise_teams", state: "unavailable"},
]}, cache: {source, error: null}});

test("enterprise URL parsing routes cloud and data-resident hosts without guessing or accepting credentials", () => {
    assert.deepEqual(parseEnterpriseUrl(" https://github.com/enterprises/example-enterprise/ "), config);
    assert.deepEqual(parseEnterpriseUrl("https://tenant.ghe.com/enterprises/example-enterprise"),
        {...config, host: "tenant.ghe.com"});
    for (const value of ["http://github.com/enterprises/example-enterprise", "https://github.com.evil.test/enterprises/example-enterprise",
        "https://evil@github.com/enterprises/example-enterprise", "https://github.com:444/enterprises/example-enterprise",
        "https://github.com/enterprises/example-enterprise?token=sample", "https://tenant.ghe.com", "https://github.com/enterprises/a%2Fb",
        "https://tenant.ghe.com.evil.test/enterprises/example-enterprise"]) assert.throws(() => parseEnterpriseUrl(value));
});

test("cold cache reads do not create a database and target persistence is separate and private", async () => {
    const root = mkdtempSync(join(tmpdir(), "finops-onboarding-"));
    const previous = process.env.GITHUB_FINOPS_CACHE_DIR;
    process.env.GITHUB_FINOPS_CACHE_DIR = join(root, "new-cache");
    try {
        assert.equal(await cachedOverview(config, {cacheOnly: true}), null);
        assert.equal(existsSync(process.env.GITHUB_FINOPS_CACHE_DIR), false);
        const path = join(root, "target.json");
        assert.equal(await readTarget(path), null);
        await saveTarget(config, path);
        assert.deepEqual(await readTarget(path), config);
        if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
        writeFileSync(path, "{broken");
        await assert.rejects(readTarget(path), /Could not read the saved enterprise target/);
    } finally {
        if (previous === undefined) delete process.env.GITHUB_FINOPS_CACHE_DIR;
        else process.env.GITHUB_FINOPS_CACHE_DIR = previous;
        rmSync(root, {recursive: true, force: true});
    }
});

test("CLI checks are local, failures explicit, and optional teams do not block verified billing", async () => {
    assert.equal((await cliStatus(async (command, args) => {
        assert.equal(command, "gh");assert.deepEqual(args, ["--version"]);return {stdout: "gh fixture\nDetails"};
    })).version, "gh fixture");
    assert.equal((await cliStatus(async () => {throw Object.assign(new Error(), {code: "ENOENT"});})).installed, false);
    assert.match((await cliStatus(async () => {throw Object.assign(new Error(), {code: "EACCES"});})).error, /could not run/);
    assert.equal(canLoadOverview(connection()), true);
    assert.equal(canLoadOverview(connection("cached")), false);
    assert.equal(canLoadOverview({...connection(), data: {checks: [{key: "budgets", state: "accessible"}]}}), false);
});

test("cold server requires explicit same-origin checks before loading and remembers only the confirmed target", async () => {
    const calls = [], saved = [];
    const {server, url, getConfig} = await startServer({}, async (target, options) => {
        calls.push({target, options});
        if (options.resource === "connection") return connection();
        return {budgets: []};
    }, {restoreTarget: async () => null, persistTarget: async target => saved.push(target), cli,
        version: async () => ({version: "0.1.0"}), dbPath: () => "/fixture/cache.sqlite"});
    const request = (route, target = "https://github.com/enterprises/example-enterprise", origin = new URL(url).origin) =>
        fetch(`${url}${route}`, {method: "POST", headers: {"Content-Type": "application/json", Origin: origin},
            body: JSON.stringify({enterpriseUrl: target})});
    try {
        const boot = await (await fetch(`${url}startup`)).json();
        assert.equal(boot.hasOverview, false);assert.equal(boot.target, null);assert.equal(calls.length, 0);
        assert.equal((await fetch(`${url}overview`)).status, 409);
        assert.equal((await request("connect/check", undefined, "https://evil.test")).status, 403);
        assert.equal((await request("connect/load")).status, 400);
        assert.equal((await request("connect/check")).status, 200);
        assert.equal(calls.length, 1);assert.equal(calls[0].options.resource, "connection");assert.equal(saved.length, 0);
        assert.equal((await request("connect/load", "https://github.com/enterprises/other-enterprise")).status, 400);
        assert.equal((await request("connect/load")).status, 200);
        assert.deepEqual(saved, [config]);assert.deepEqual(getConfig(), config);
        const warm = await (await fetch(`${url}startup`)).json();
        assert.equal(warm.hasOverview, true);
        assert.deepEqual(calls.at(-1).options, {cacheOnly: true});
    } finally {await new Promise(resolve => server.close(resolve));}
});

test("warm startup treats an empty saved overview as usable and performs no live API check", async () => {
    const calls = [];
    const {server, url} = await startServer(config, async (_target, options) => {calls.push(options);return {budgets: []};}, {cli});
    try {
        assert.equal((await (await fetch(`${url}startup`)).json()).hasOverview, true);
        assert.deepEqual(calls, [{cacheOnly: true}]);
    } finally {await new Promise(resolve => server.close(resolve));}
});
