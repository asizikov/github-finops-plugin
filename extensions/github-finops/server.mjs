import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { validateInput } from "./budgets.mjs";
import { cachedOverview } from "./cache.mjs";

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GitHub FinOps</title><link rel="stylesheet" href="./app.css"></head>
<body><div id="root"></div><script src="./app.js" defer></script></body></html>`;

export async function startServer(input, load = cachedOverview) {
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
        if (req.method !== "GET") {
            res.writeHead(405, { Allow: "GET" }).end();
            return;
        }
        const route = req.url?.startsWith(prefix) ? req.url.slice(prefix.length) : null;
        const centerRoute = route?.match(/^cost-centers(?:\/([a-zA-Z0-9-]+))?(\?refresh=1)?$/);
        if (route === "overview" || route === "overview?refresh=1" || centerRoute) {
            res.setHeader("Content-Type", "application/json");
            try {
                const options = { refresh: route.endsWith("?refresh=1") };
                if (centerRoute) {
                    options.resource = centerRoute[1] ? "cost-center-detail" : "cost-centers";
                    if (centerRoute[1]) options.id = centerRoute[1];
                }
                res.end(JSON.stringify(await load(config, options)));
            } catch (error) {
                console.error("Overview read failed:", error);
                res.writeHead(502).end(JSON.stringify({
                    error: error.publicMessage ?? "Could not read budgets. Check gh authentication, enterprise access, hostname, and network connectivity, then refresh.",
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
