import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createPreferences, targetFile} from "./preferences.mjs";
import {startServer} from "./server.mjs";

const config = {enterprise: "example-enterprise", host: "github.com"};
const other = {enterprise: "other-enterprise", host: "tenant.ghe.com"};
const fileFor = (dir, {host, enterprise}) => targetFile(dir, `${host}/${enterprise}`);

async function withDir(run) {
    const dir = await mkdtemp(join(tmpdir(), "finops-prefs-"));
    try { await run(join(dir, "preferences")); } finally { await rm(dir, {recursive: true, force: true}); }
}

test("stores the budget SKU per host and enterprise in private user-local files", () => withDir(async dir => {
    const preferences = createPreferences({path: dir});
    assert.deepEqual(await preferences.read(config), {budgetSku: null});
    assert.deepEqual(await preferences.update(config, {budgetSku: "ai_credits"}), {budgetSku: "ai_credits"});
    await preferences.update(other, {budgetSku: "actions"});
    assert.deepEqual(await preferences.read({enterprise: "Example-Enterprise", host: "github.com"}), {budgetSku: "ai_credits"});
    assert.deepEqual(await preferences.read({enterprise: "example-enterprise", host: "tenant.ghe.com"}), {budgetSku: null});
    assert.equal((await stat(fileFor(dir, config))).mode & 0o777, 0o600);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.doesNotMatch(await readFile(fileFor(dir, config), "utf8"), /token|gh[op]_/i);
    assert.deepEqual(await preferences.update(config, {budgetSku: null}), {budgetSku: null});
    await assert.rejects(preferences.update(config, {budgetSku: "../x"}), /Invalid budget SKU/);
    await assert.rejects(preferences.update(config, {other: 1}), /No supported/);
}));

test("concurrent canvases for different enterprises keep both saved choices", () => withDir(async dir => {
    await Promise.all(Array.from({length: 10}, (_, i) =>
        createPreferences({path: dir}).update(i % 2 ? other : config, {budgetSku: i % 2 ? "actions" : "ai_credits"})));
    assert.deepEqual(await createPreferences({path: dir}).read(config), {budgetSku: "ai_credits"});
    assert.deepEqual(await createPreferences({path: dir}).read(other), {budgetSku: "actions"});
    assert.equal((await readdir(dir)).filter(name => name.endsWith(".tmp")).length, 0);
}));

test("unreadable or malformed saved preferences fail explicitly and keep files unchanged", () => withDir(async dir => {
    const preferences = createPreferences({path: dir});
    await preferences.update(other, {budgetSku: "actions"});
    const otherBytes = await readFile(fileFor(dir, other), "utf8");
    await mkdir(dir, {recursive: true});
    const file = fileFor(dir, config);
    for (const bytes of ["{not json", JSON.stringify({version: 2, target: "github.com/example-enterprise", budgetSku: "actions"}),
        JSON.stringify({version: 1, target: "github.com/someone-else", budgetSku: "actions"}),
        JSON.stringify({version: 1, target: "github.com/example-enterprise", pad: "x".repeat(70000)})]) {
        await writeFile(file, bytes);
        await assert.rejects(preferences.read(config), error => /Showing all SKUs/.test(error.publicMessage));
        await assert.rejects(preferences.update(config, {budgetSku: "ai_credits"}), error => error.status === 500 && /left unchanged/.test(error.publicMessage));
        assert.equal(await readFile(file, "utf8"), bytes);
    }
    await writeFile(file, JSON.stringify({version: 1, target: "github.com/example-enterprise", budgetSku: "../bad"}));
    await assert.rejects(preferences.read(config), error => /saved budget SKU filter is malformed/.test(error.publicMessage));
    assert.deepEqual(await preferences.update(config, {budgetSku: "ai_credits"}), {budgetSku: "ai_credits"});
    assert.deepEqual(await preferences.read(config), {budgetSku: "ai_credits"});
    assert.equal(await readFile(fileFor(dir, other), "utf8"), otherBytes);
}));

test("the saved SKU survives reopening the canvas on a different loopback port", () => withDir(async dir => {
    const open = () => startServer(config, async () => ({}), {preferences: createPreferences({path: dir})});
    const first = await open();
    try {
        const origin = new URL(first.url).origin;
        const post = (url, body, headers = {origin}) => fetch(`${url}preferences`, {method: "POST", headers: {"content-type": "application/json", ...headers}, body});
        assert.equal((await post(first.url, JSON.stringify({budgetSku: "ai_credits"}), {origin: "http://evil.example"})).status, 403);
        assert.equal((await post(first.url, JSON.stringify({budgetSku: "bad sku"}))).status, 400);
        assert.equal((await post(first.url, JSON.stringify({budgetSku: "ai_credits"}))).status, 200);
    } finally { await new Promise(resolve => first.server.close(resolve)); }
    const second = await open();
    try {
        assert.notEqual(new URL(second.url).port, new URL(first.url).port);
        assert.deepEqual(await (await fetch(`${second.url}preferences`)).json(), {budgetSku: "ai_credits"});
    } finally { await new Promise(resolve => second.server.close(resolve)); }
}));
