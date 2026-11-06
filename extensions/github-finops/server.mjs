import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { validateInput } from "./budgets.mjs";
import { cachedOverview, databasePath } from "./cache.mjs";
import {versionInfo, authSource, revealDatabase} from "./settings.mjs";

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GitHub FinOps</title><link rel="stylesheet" href="./app.css"></head>
<body><div id="root"></div><script src="./app.js" defer></script></body></html>`;

export async function readSettings(config, refresh = false, {
    load = cachedOverview, version = versionInfo, dbPath = databasePath,
} = {}) {
    let connection = null;
    let connectionError = null;
    let retryAt = null;
    try { connection = await load(config, {resource: "connection", refresh, cacheOnly: !refresh}); }
    catch (error) {
        console.error("Settings connection check failed:", error);
        connectionError = error.publicMessage ?? "Could not read connection checks. Check local gh authentication and cache access.";
        retryAt = error.retryAt ?? null;
    }
    return {version: await version(), database: dbPath(), authSource: authSource(config.host),
        target: config, connection, connectionError, retryAt};
}

export async function startServer(input, load = cachedOverview, {version = versionInfo, reveal = revealDatabase, dbPath = databasePath} = {}) {
    const config = validateInput(input);
    const prefix = `/${randomBytes(24).toString("hex")}/`;
    const [js, css] = await Promise.all([
        readFile(new URL("./assets/app.js", import.meta.url)),
        readFile(new URL("./assets/app.css", import.meta.url)),
    ]);
    const server = createServer(async (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'");
        const address = server.address();
        if (!address || typeof address === "string" ||
            req.headers.host !== `127.0.0.1:${address.port}` ||
            (req.headers["sec-fetch-site"] && !["same-origin", "none"].includes(req.headers["sec-fetch-site"]))) {
            res.writeHead(403).end();
            return;
        }
        const route = req.url?.startsWith(prefix) ? req.url.slice(prefix.length) : null;
        if (route === "settings/reveal" && req.method === "POST") {
            res.setHeader("Content-Type", "application/json");
            if (req.headers.origin !== `http://${req.headers.host}`) {
                res.writeHead(403).end(JSON.stringify({error: "Opening the cache folder requires a same-origin request."}));
                return;
            }
            try { res.end(JSON.stringify(await reveal(dbPath()))); }
            catch (error) {
                console.error("Cache reveal failed:", error);
                res.writeHead(500).end(JSON.stringify({error: error.message}));
            }
            return;
        }
        if (req.method !== "GET") {
            res.writeHead(405, { Allow: "GET" }).end();
            return;
        }
        if (route === "settings" || route === "settings?refresh=1") {
            res.setHeader("Content-Type", "application/json");
            try {
                res.end(JSON.stringify(await readSettings(config, route.endsWith("?refresh=1"), {load, version, dbPath})));
            } catch (error) {
                console.error("Settings read failed:", error);
                res.writeHead(502).end(JSON.stringify({error: error.publicMessage ?? "Could not load local settings or connection checks.", retryAt: error.retryAt ?? null}));
            }
            return;
        }
        const centerRoute = route?.match(/^cost-centers(?:\/([a-zA-Z0-9-]+))?(\?refresh=1)?$/);
        const budgetRoute = route?.match(/^budgets(?:\/([a-zA-Z0-9-]+))?(\?refresh=1)?$/);
        const userRoute = route?.match(/^users\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,99})(\?refresh=1)?$/);
        const teamRoute = route?.match(/^team-cost-centers\/((?:ent(?::|%3[Aa]))?[a-zA-Z0-9][a-zA-Z0-9_-]*)(\?refresh=1)?$/);
        if (route === "overview" || route === "overview?refresh=1" || centerRoute || budgetRoute || userRoute || teamRoute) {
            res.setHeader("Content-Type", "application/json");
            try {
                const options = { refresh: route.endsWith("?refresh=1") };
                if (centerRoute) {
                    options.resource = centerRoute[1] ? "cost-center-detail" : "cost-centers";
                    if (centerRoute[1]) options.id = centerRoute[1];
                }
                if (budgetRoute) {
                    options.resource = budgetRoute[1] ? "budget-detail" : "budgets";
                    if (budgetRoute[1]) options.id = budgetRoute[1];
                }
                if (userRoute) {options.resource = "user";options.id = userRoute[1];}
                if (teamRoute) {options.resource = "team-cost-centers";options.id = decodeURIComponent(teamRoute[1]);}
                res.end(JSON.stringify(await load(config, options)));
            } catch (error) {
                console.error("Canvas data read failed:", error);
                res.writeHead(502).end(JSON.stringify({
                    error: error.publicMessage ?? "Could not read billing data. Check gh authentication, enterprise access, hostname, and network connectivity, then refresh.",
                    retryAt: error.retryAt ?? null,
                }));
            }
        } else if (route === "" || route === "app.js" || route === "app.css") {
            res.setHeader("Content-Type", route === "app.js" ? "text/javascript" :
                route === "app.css" ? "text/css" : "text/html; charset=utf-8");
            res.end(route === "app.js" ? js : route === "app.css" ? css : html);
        } else {
            res.writeHead(404).end();
        }
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Canvas server did not acquire a loopback port.");
    return { server, url: `http://127.0.0.1:${address.port}${prefix}` };
}
