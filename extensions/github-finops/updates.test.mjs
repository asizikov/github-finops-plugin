import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, rm, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {CHECK_INTERVAL, VERSION_URL, UPDATE_URL, compareVersions, parseVersion, publishedVersion, createUpdateChecker} from "./updates.mjs";
import {startServer} from "./server.mjs";

async function fixture(t, options = {}) {
    const directory = await mkdtemp(join(tmpdir(), "finops-updates-"));
    t.after(() => rm(directory, {recursive: true, force: true}));
    return {file: join(directory, "updates.json"), installed: async () => "0.2.0", log: () => {}, ...options};
}

test("SemVer compares numeric cores, prerelease identifiers and ignores build metadata", () => {
    const order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2",
        "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.2.0", "1.10.0", "2.0.0"];
    for (let i = 1; i < order.length; i++) {
        assert.equal(compareVersions(order[i], order[i - 1]), 1);
        assert.equal(compareVersions(order[i - 1], order[i]), -1);
    }
    assert.equal(compareVersions("1.0.0+build.1", "1.0.0+other"), 0);
    assert.equal(compareVersions("1.0.0-beta+build.1", "1.0.0-beta"), 0);
    assert.equal(compareVersions("100000000000000000000.0.0", "99999999999999999999.0.0"), 1);
    assert.equal(parseVersion("0.2.0\n").version, "0.2.0");
    for (const invalid of ["v1.0.0", "01.0.0", "1.0", "1.0.0-01", "1.0.0-a..b", "1.0.0+", "1.0.0\n1.0.1",
        '{"version":"1.0.0"}', "<script>alert(1)</script>", "1.0.0-" + "a".repeat(200)]) {
        assert.throws(() => parseVersion(invalid), /invalid/);
    }
});

test("published read uses only fixed public URL without credentials and enforces size/shape", async () => {
    const request = async (url, options) => {
        assert.equal(url, VERSION_URL);
        assert.equal(options.credentials, "omit");
        assert.equal(options.redirect, "error");
        assert.deepEqual(options.headers, {Accept: "text/plain"});
        return new Response("0.3.0\n");
    };
    assert.equal(await publishedVersion({request}), "0.3.0");
    for (const body of ["no version", "1.0.0\n1.1.0", "x".repeat(201)]) {
        await assert.rejects(publishedVersion({request: async () => new Response(body)}));
    }
    await assert.rejects(publishedVersion({request: async () => new Response("0.3.0", {headers: {"content-length": "201"}})}), /too large/);
    await assert.rejects(publishedVersion({request: async () => new Response("", {status: 404})}), /HTTP 404/);
    await assert.rejects(publishedVersion({request: async () => {throw new Error("offline");}}), /offline/);
});

test("timeout covers both the request and a stalled response body", async () => {
    const stalled = (_, {signal}) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), {once: true});
    });
    await assert.rejects(publishedVersion({request: stalled, timeout: 10}), /aborted/);
    const body = (_, {signal}) => Promise.resolve(new Response(new ReadableStream({
        start(controller) {signal.addEventListener("abort", () => controller.error(new Error("body aborted")), {once: true});},
    })));
    await assert.rejects(publishedVersion({request: body, timeout: 10}), /body aborted/);
});

test("equal and older versions never produce an offer; installed version stays local", async t => {
    for (const latest of ["0.1.9", "0.2.0", "0.2.0+rebuild", "0.2.0-rc.1"]) {
        const checker = createUpdateChecker(await fixture(t, {latest: async () => latest}));
        const result = await checker.check();
        assert.equal(result.installed, "0.2.0");
        assert.equal(result.latest, latest);
        assert.equal(result.available, false);
    }
});

test("coalesces requests, persists daily cadence and exact-version dismissal across restarts", async t => {
    let time = 1000, calls = 0, offer = "0.3.0";
    const options = await fixture(t, {now: () => time, latest: async () => {calls++;return offer;}});
    const checker = createUpdateChecker(options);
    const [a, b] = await Promise.all([checker.check(), checker.check()]);
    assert.deepEqual(a, b);
    assert.equal(a.available, true);
    assert.equal(a.updateUrl, UPDATE_URL);
    assert.equal(calls, 1);
    await checker.check();
    assert.equal(calls, 1);
    await assert.rejects(checker.dismiss("9.0.0"), /changed/);
    assert.equal((await checker.dismiss("0.3.0")).available, false);
    assert.equal((await checker.dismiss("0.3.0")).available, false);
    const restarted = createUpdateChecker(options);
    assert.equal((await restarted.check()).available, false);
    assert.equal(calls, 1);
    time += CHECK_INTERVAL - 1;
    await restarted.check();
    assert.equal(calls, 1);
    time += 1;
    assert.equal((await restarted.check()).available, false);
    assert.equal(calls, 2);
    offer = "0.4.0";
    time += CHECK_INTERVAL;
    assert.equal((await restarted.check()).available, true);
    assert.equal(calls, 3);
    assert.equal(JSON.parse(await readFile(options.file)).dismissed, "0.3.0");
});

test("offline, malformed and timeout errors stay unknown, retain last success, and retry only next day", async t => {
    for (const failure of [async () => {throw new Error("offline");}, async () => "bad",
        () => publishedVersion({timeout: 10, request: (_, {signal}) => new Promise((resolve, reject) =>
            signal.addEventListener("abort", () => reject(new Error("timeout")), {once: true}))})]) {
        let time = 1000, fail = false, calls = 0;
        const logs = [];
        const options = await fixture(t, {now: () => time, log: message => logs.push(message),
            latest: async () => {calls++;return fail ? failure() : "0.3.0";}});
        const checker = createUpdateChecker(options);
        const success = await checker.check();
        fail = true;time += CHECK_INTERVAL;
        const result = await checker.check();
        assert.equal(result.available, false);
        assert.equal(result.latest, "0.3.0");
        assert.equal(result.checkedAt, success.checkedAt);
        assert.match(result.error, /Could not check/);
        assert.equal(logs.length, 1);
        assert.equal((await createUpdateChecker(options).check()).available, false);
        assert.equal(calls, 2);
        fail = false;time += CHECK_INTERVAL;
        assert.equal((await checker.check()).available, true);
        assert.equal(calls, 3);
    }
});

test("invalid saved state is diagnosed; dismissal persistence failure remains visible", async t => {
    const logs = [];
    const options = await fixture(t, {log: message => logs.push(message), latest: async () => "0.3.0"});
    await writeFile(options.file, '{"latest":"not-semver"}');
    const checker = createUpdateChecker(options);
    assert.equal((await checker.check()).available, true);
    assert.equal(logs.length, 1);
    await rm(options.file);
    await rm(join(options.file, ".."), {recursive: true});
    await writeFile(join(options.file, ".."), "blocks directory");
    await assert.rejects(checker.dismiss("0.3.0"), /Could not save/);
    assert.equal((await checker.check()).available, true);
});

test("update endpoints work before onboarding and require same-origin dismissal without billing reads", async t => {
    const options = await fixture(t, {latest: async () => "0.3.0"});
    const {server, url} = await startServer({}, async () => {throw new Error("Must not load billing");},
        {restoreTarget: async () => null, updates: createUpdateChecker(options)});
    t.after(() => new Promise(resolve => server.close(resolve)));
    const origin = new URL(url).origin;
    assert.equal((await (await fetch(`${url}updates`)).json()).available, true);
    assert.equal((await fetch(`${url}updates/dismiss`, {method: "POST", body: '{"version":"0.3.0"}'})).status, 403);
    assert.equal((await fetch(`${url}updates/dismiss`)).status, 409);
    const result = await fetch(`${url}updates/dismiss`, {method: "POST", headers: {origin}, body: '{"version":"0.3.0"}'});
    assert.equal(result.status, 200);
    assert.equal((await result.json()).available, false);
    assert.equal((await (await fetch(`${url}updates`)).json()).available, false);
});
