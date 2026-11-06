import { joinSession, createCanvas } from "@github/copilot-sdk/extension";
import { startServer } from "./server.mjs";

const servers = new Map();

await joinSession({
    canvases: [
        createCanvas({
            id: "github-finops",
            displayName: "GitHub FinOps",
            description: "Read-only enterprise AI Credits budget overview.",
            inputSchema: {
                type: "object",
                properties: {
                    enterprise: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$" },
                    host: { type: "string", description: "GitHub hostname; defaults to github.com." },
                },
                required: ["enterprise"],
                additionalProperties: false,
            },
            open: async (ctx) => {
                const configKey = JSON.stringify(ctx.input);
                let entry = servers.get(ctx.instanceId);
                if (entry && entry.configKey !== configKey) {
                    throw new Error("Close this canvas before opening it with a different enterprise.");
                }
                if (!entry) {
                    const pending = startServer(ctx.input);
                    entry = { configKey, pending };
                    servers.set(ctx.instanceId, entry);
                    pending.catch(() => servers.delete(ctx.instanceId));
                }
                const { url } = await entry.pending;
                return { title: "GitHub FinOps", url };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    const { server } = await entry.pending;
                    await new Promise((resolve, reject) => {
                        server.close((error) => error ? reject(error) : resolve());
                    });
                }
            },
        }),
    ],
});
