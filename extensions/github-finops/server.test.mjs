import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { startServer } from "./server.mjs";

function status(url, headers) {
    return new Promise((resolve, reject) => {
        const req = request(url, { headers }, res => {
            res.resume();
            resolve(res.statusCode);
        });
        req.on("error", reject);
        req.end();
    });
}

test("serves bundled UI and normalized reads only within its protected loopback URL", async () => {
    const loads = [];
    const { server, url } = await startServer({ enterprise: "example-enterprise" }, async (config, options) => {
        loads.push(options);
        return { budgets: [] };
    });
    try {
        assert.match(await (await fetch(url)).text(), /id="root"/);
        assert.match((await fetch(`${url}app.js`)).headers.get("content-type"), /javascript/);
        assert.deepEqual(await (await fetch(`${url}overview`)).json(), { budgets: [] });
        assert.deepEqual(await (await fetch(`${url}overview?refresh=1`)).json(), { budgets: [] });
        assert.deepEqual(loads, [{ refresh: false }, { refresh: true }]);
        assert.equal((await fetch(`${url}cost-centers`)).status,200);
        assert.equal((await fetch(`${url}cost-centers/center-one?refresh=1`)).status,200);
        assert.deepEqual(loads.slice(2),[
            {refresh:false,resource:"cost-centers"},
            {refresh:true,resource:"cost-center-detail",id:"center-one"},
        ]);
        assert.equal((await fetch(new URL("/", url))).status, 404);
        assert.equal((await fetch(`${url}overview`, { method: "POST" })).status, 405);
        assert.equal(await status(`${url}overview`, { "sec-fetch-site": "cross-site" }), 403);
        assert.equal(await status(`${url}overview`, { host: "evil.example" }), 403);
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});
