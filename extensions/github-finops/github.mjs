import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const exec = promisify(execFile);

export class GitHubReadError extends Error {
    constructor(message, retryAt = null, status = null) {
        super(message);
        this.retryAt = retryAt;
        this.publicMessage = message;
        this.status = status;
    }
}

export function parseResponse(stdout) {
    const text = stdout.replaceAll("\r\n", "\n");
    const end = text.indexOf("\n\n");
    if (end === -1 || !text.startsWith("HTTP/")) throw new Error("GitHub CLI returned invalid response headers.");
    const lines = text.slice(0, end).split("\n");
    const status = Number(lines.shift()?.match(/^HTTP\/[\d.]+\s+(\d+)/)?.[1]);
    const headers = new Map(lines.map(line => {
        const colon = line.indexOf(":");
        return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
    }));
    return { status, headers, body: text.slice(end + 2) };
}

export function rateLimitDeadline({ status, headers, body }, now = Date.now()) {
    const retryAfter = headers.get("retry-after");
    const reset = headers.get("x-ratelimit-reset");
    let deadline = null;
    if (retryAfter) {
        const value = /^\d+(\.\d+)?$/.test(retryAfter)
            ? now + Number(retryAfter) * 1000 : Date.parse(retryAfter);
        if (Number.isFinite(value) && value > now) deadline = value;
    }
    if (headers.get("x-ratelimit-remaining") === "0" && reset) {
        const value = Number(reset) * 1000;
        if (Number.isFinite(value) && value > now) deadline = Math.max(deadline ?? 0, value);
    }
    if (deadline === null && (status === 429 || (status === 403 && /rate limit/i.test(body)))) {
        deadline = now + 60000;
    }
    return deadline === null ? null : new Date(deadline).toISOString();
}

export async function ghRead(path, host, onLimit) {
    let stdout;
    try {
        ({ stdout } = await exec("gh", [
            "api", "--method", "GET", "--hostname", host, "--include",
            "-H", "X-GitHub-Api-Version: 2026-03-10", path,
        ], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 }));
    } catch (error) {
        let retryAt = null;
        let status = null;
        if (typeof error.stdout === "string" && error.stdout.startsWith("HTTP/")) {
            const response = parseResponse(error.stdout);
            retryAt = rateLimitDeadline(response);
            status = response.status;
        }
        throw new GitHubReadError(retryAt
            ? "GitHub requests are rate-limited. Cached data is retained until refresh is available."
            : "Could not read GitHub billing data. Check gh authentication, billing access, hostname, and connectivity.",
        retryAt, status);
    }
    const response = parseResponse(stdout);
    const data = JSON.parse(response.body);
    const retryAt = rateLimitDeadline(response);
    if (retryAt) onLimit?.(retryAt);
    return data;
}

export async function localAccessContext(host) {
    let stdout;
    try {
        ({ stdout } = await exec("gh", ["auth", "token", "--hostname", host], {
            timeout: 10000, maxBuffer: 16384,
        }));
    } catch {
        throw new GitHubReadError("Could not identify the active local gh credentials. Sign in to the configured host before opening cached data.");
    }
    const token = stdout.trim();
    if (!token) throw new GitHubReadError("The active local gh credential is empty.");
    // Only the irreversible context digest is persisted, never the credential.
    return createHash("sha256").update("github-finops-cache-v1\0").update(host.toLowerCase())
        .update("\0").update(token).digest("hex");
}
