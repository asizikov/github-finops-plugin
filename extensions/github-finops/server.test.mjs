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
        assert.equal((await fetch(`${url}budgets`)).status,200);
        assert.equal((await fetch(`${url}budgets/budget-one?refresh=1`)).status,200);
        assert.deepEqual(loads.slice(4),[
            {refresh:false,resource:"budgets"},
            {refresh:true,resource:"budget-detail",id:"budget-one"},
        ]);
        assert.equal((await fetch(`${url}users/sample-user`)).status,200);
        assert.equal((await fetch(`${url}users/sample-user?refresh=1`)).status,200);
        assert.deepEqual(loads.slice(6),[
            {refresh:false,resource:"user",id:"sample-user"},
            {refresh:true,resource:"user",id:"sample-user"},
        ]);
        assert.equal((await fetch(`${url}team-cost-centers/ent%3Aengineering`)).status,200);
        assert.equal((await fetch(`${url}team-cost-centers/ent:engineering?refresh=1`)).status,200);
        assert.deepEqual(loads.slice(8),[
            {refresh:false,resource:"team-cost-centers",id:"ent:engineering"},
            {refresh:true,resource:"team-cost-centers",id:"ent:engineering"},
        ]);
        assert.equal((await fetch(`${url}team-cost-centers/ent%3Aengineering%2Fother`)).status,404);
        assert.equal((await fetch(`${url}users/not/a/user`)).status,404);
        assert.equal((await fetch(new URL("/", url))).status, 404);
        assert.equal((await fetch(`${url}overview`, { method: "POST" })).status, 405);
        assert.equal(await status(`${url}overview`, { "sec-fetch-site": "cross-site" }), 403);
        assert.equal(await status(`${url}overview`, { host: "evil.example" }), 403);
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});
