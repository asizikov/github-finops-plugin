import {readFile, mkdir, writeFile, rename} from "node:fs/promises";
import {homedir} from "node:os";
import {dirname, join} from "node:path";
import {randomUUID} from "node:crypto";

export const CHECK_INTERVAL = 15 * 60 * 1000;
export const VERSION_URL = "https://raw.githubusercontent.com/asizikov/github-finops-plugin/main/VERSION";
export const UPDATE_URL = "https://github.com/asizikov/github-finops-plugin/blob/main/docs/SETUP.md#updating-the-plugin";
const rootVersion = new URL("../../VERSION", import.meta.url);
const identifier = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
const semver = new RegExp(`^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-(${identifier}(?:\\.${identifier})*))?(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$`);

export function parseVersion(text) {
    if (typeof text !== "string" || text.length > 200) throw new Error("The plugin version is invalid.");
    const version = text.trim();
    const match = semver.exec(version);
    if (!match) throw new Error("The plugin version is invalid.");
    return {version, core: match.slice(1, 4).map(BigInt), pre: match[4]?.split(".") ?? []};
}

export function compareVersions(left, right) {
    const a = parseVersion(left), b = parseVersion(right);
    for (let i = 0; i < 3; i++) {
        if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
    }
    if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
    for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
        const x = a.pre[i], y = b.pre[i];
        if (x === y) continue;
        if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
        const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
        if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
        if (xn !== yn) return xn ? -1 : 1;
        return x > y ? 1 : -1;
    }
    return 0;
}

export async function installedVersion(file = rootVersion) {
    return parseVersion(await readFile(file, "utf8")).version;
}

export async function publishedVersion({request = fetch, timeout = 5000} = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await request(VERSION_URL, {
            signal: controller.signal, redirect: "error", credentials: "omit",
            headers: {Accept: "text/plain"}, cache: "no-store",
        });
        if (!response.ok || Number(response.headers.get("content-length")) > 200) {
            await response.body?.cancel();
            throw new Error(!response.ok ? `Version check returned HTTP ${response.status}.` : "Version response is too large.");
        }
        const reader = response.body.getReader();
        const chunks = [];
        let length = 0;
        try {
            for (;;) {
                const {done, value} = await reader.read();
                if (done) break;
                length += value.byteLength;
                if (length > 200) throw new Error("Version response is too large.");
                chunks.push(value);
            }
        } finally {await reader.cancel();}
        return parseVersion(new TextDecoder("utf-8", {fatal: true}).decode(Buffer.concat(chunks))).version;
    } finally {clearTimeout(timer);}
}

export function createUpdateChecker({
    file = join(process.env.COPILOT_HOME || join(homedir(), ".copilot"), "extensions", "github-finops", "artifacts", "updates.json"),
    installed = installedVersion, latest = publishedVersion, now = Date.now,
    log = message => console.error("Plugin update check:", message),
} = {}) {
    let pending;
    let state;
    async function readState() {
        if (state) return;
        state = {attemptedAt: null, checkedAt: null, latest: null, dismissed: null, error: null};
        try {
            const text = await readFile(file, "utf8");
            if (Buffer.byteLength(text) > 2048) throw new Error("Update state is too large.");
            const saved = JSON.parse(text);
            if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("Invalid update state.");
            for (const key of ["attemptedAt", "checkedAt"]) {
                if (saved[key] != null && (!Number.isFinite(saved[key]) || saved[key] < 0)) throw new Error("Invalid update timestamp.");
            }
            for (const key of ["latest", "dismissed"]) if (saved[key] != null) parseVersion(saved[key]);
            if (saved.error != null && typeof saved.error !== "string") throw new Error("Invalid update error.");
            for (const key of Object.keys(state)) state[key] = saved[key] ?? null;
        } catch (error) {
            if (error.code !== "ENOENT") {
                log(error.message);
                state.error = "Could not read saved update status.";
            }
        }
    }
    async function save() {
        const temporary = `${file}.${randomUUID()}.tmp`;
        await mkdir(dirname(file), {recursive: true, mode: 0o700});
        await writeFile(temporary, `${JSON.stringify(state)}\n`, {mode: 0o600});
        await rename(temporary, file);
    }
    function view(version) {
        return {installed: version, latest: state.latest, checkedAt: state.checkedAt, attemptedAt: state.attemptedAt,
            error: state.error, updateUrl: UPDATE_URL,
            available: !state.error && state.latest !== null && compareVersions(state.latest, version) > 0 &&
                state.dismissed !== state.latest};
    }
    async function check() {
        if (pending) return pending;
        pending = (async () => {
            await readState();
            const version = await installed();
            if (state.attemptedAt === null || now() - state.attemptedAt >= CHECK_INTERVAL || state.attemptedAt > now()) {
                state.attemptedAt = now();
                try {
                    state.latest = parseVersion(await latest()).version;
                    state.checkedAt = now();
                    state.error = null;
                } catch (error) {
                    log(error.message);
                    state.error = "Could not check for plugin updates. The next check is in 15 minutes.";
                }
                try {await save();}
                catch (error) {log(error.message);state.error = "Could not save plugin update status.";}
            }
            return view(version);
        })();
        try {return await pending;} finally {pending = null;}
    }
    return {
        check,
        async dismiss(version) {
            const result = await check();
            if (typeof version !== "string" || version !== result.latest || result.error ||
                compareVersions(version, result.installed) <= 0) throw new Error("This update offer has changed. Reload the canvas.");
            if (state.dismissed === version) return result;
            const previous = state.dismissed;
            state.dismissed = version;
            try {await save();}
            catch (error) {state.dismissed = previous;log(error.message);throw new Error("Could not save update dismissal. Try again.");}
            return view(result.installed);
        },
    };
}

export const updateChecker = createUpdateChecker();
