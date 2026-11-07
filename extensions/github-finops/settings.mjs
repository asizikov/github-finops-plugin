import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {installedVersion} from "./updates.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));

export async function versionInfo({directory = root, run = exec} = {}) {
    const version = await installedVersion(resolve(directory, "VERSION"));
    let revision = null;
    let dirty = null;
    try {
        // Avoid reporting a containing repository's revision for an installed plugin.
        const {stdout: top} = await run("git", ["-C", directory, "rev-parse", "--show-toplevel"]);
        if (resolve(top.trim()) === resolve(directory)) {
            const {stdout} = await run("git", ["-C", directory, "rev-parse", "--short=12", "HEAD"]);
            if (!/^[a-f0-9]{7,40}$/.test(stdout.trim())) throw new Error("Invalid Git revision.");
            revision = stdout.trim();
            const status = await run("git", ["-C", directory, "status", "--porcelain", "--untracked-files=normal"]);
            dirty = status.stdout.length > 0;
        }
    } catch (error) {
        if (!["ENOENT", 128].includes(error.code)) throw error;
    }
    return {version, revision, dirty};
}

export function authSource(host, env = process.env) {
    host = host.toLowerCase();
    if (host === "github.com" || host.endsWith(".ghe.com")) {
        if (env.GH_TOKEN) return "GH_TOKEN environment override";
        if (env.GITHUB_TOKEN) return "GITHUB_TOKEN environment override";
        return "Stored gh credentials";
    }
    if (env.GH_ENTERPRISE_TOKEN) return "GH_ENTERPRISE_TOKEN environment override (enterprise hosts)";
    if (env.GITHUB_ENTERPRISE_TOKEN) return "GITHUB_ENTERPRISE_TOKEN environment override (enterprise hosts)";
    return "Stored gh credentials";
}

export async function revealDatabase(path, {platform = process.platform, run = exec} = {}) {
    const file = resolve(path);
    const command = platform === "darwin" ? ["open", ["-R", file]]
        : platform === "win32" ? ["explorer.exe", [`/select,${file}`]]
            : platform === "linux" ? ["xdg-open", [dirname(file)]] : null;
    if (!command) throw new Error("Opening the cache folder is not supported on this operating system.");
    try { await run(command[0], command[1], {timeout: 10000, maxBuffer: 16384}); }
    catch {
        throw new Error("Could not open the cache folder. Open the displayed location manually or check desktop file-manager access.");
    }
    return {opened: true};
}

function capabilityError(error) {
    const status = error.status ?? null;
    if (error.diagnosticState === "missing_scope") {
        return {state: "missing_scope", status, message: "The enterprise identity query requires an OAuth scope not granted to this credential."};
    }
    return {state: error.retryAt ? "rate_limited" : status === 401 ? "unauthenticated" :
        status === 403 ? "forbidden" : status === 404 ? "unavailable" : "unknown",
    status, message: error.retryAt ? "Rate limited; remaining checks are paused."
        : status === 401 ? "Authentication was rejected."
            : status === 403 ? "Forbidden: role, scope, policy or SSO authorization may be missing."
                : status === 404 ? "Not visible or unsupported; this does not prove the enterprise or membership does not exist."
                    : "Could not verify access. Check gh authentication, host and connectivity."};
}

export async function loadConnection({enterprise, host}, read, now = new Date()) {
    const checks = [];
    let scopes = null;
    let login = null;
    let name = null;
    async function probe(key, path, inspect, validate = () => true, identity) {
        try {
            const data = await read(path, host, inspect, identity);
            if (data?.errors?.some(error => error.type === "INSUFFICIENT_SCOPES")) {
                throw Object.assign(new Error("Missing query scope."), {diagnosticState: "missing_scope", status: 200});
            }
            if (!validate(data)) throw new Error("Unexpected diagnostic response.");
            checks.push({key, state: "accessible", status: 200, message: "Read endpoint accessible at the last check."});
            return data;
        } catch (error) {
            if (error.code === "local_cache_error") throw error;
            checks.push({key, ...capabilityError(error)});
            return null;
        }
    }
    const profile = await probe("authentication", "/user", metadata => {
        scopes = metadata.scopes;
    }, data => typeof data?.login === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(data.login));
    login = profile?.login ?? null;
    const base = `/enterprises/${encodeURIComponent(enterprise)}`;
    const billing = `${base}/settings/billing`;
    const target = await probe("enterprise", "/graphql", undefined, response =>
        !response?.errors?.length && typeof response?.data?.enterprise?.name === "string" &&
        response.data.enterprise.slug?.toLowerCase() === enterprise.toLowerCase(), {enterprise});
    name = target?.data.enterprise.name ?? null;
    await probe("budgets", `${billing}/budgets?per_page=1&page=1`, undefined, data => Array.isArray(data?.budgets));
    await probe("cost_centers", `${billing}/cost-centers`, undefined, data => Array.isArray(data?.costCenters));
    await probe("ai_usage", `${billing}/ai_credit/usage?year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`,
        undefined, data => Array.isArray(data?.usageItems));
    if (login) await probe("enterprise_teams", `${base}/members/${encodeURIComponent(login)}/teams?per_page=1&page=1`,
        undefined, Array.isArray);
    else checks.push({key: "enterprise_teams", state: "not_checked", status: null, message: "An authenticated username is required to probe team access."});
    return {login, name, loginAt: login ? now.toISOString() : null, nameAt: name ? now.toISOString() : null,
    scopes, readEnterpriseScope: scopes === null ? "unknown" :
        scopes.some(scope => ["read:enterprise", "manage_billing:enterprise", "admin:enterprise"].includes(scope)) ? "present" : "missing",
    checkedAt: now.toISOString(), checks};
}
