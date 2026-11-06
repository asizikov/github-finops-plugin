import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {readFile, mkdir, writeFile, rename, rm} from "node:fs/promises";
import {dirname, join} from "node:path";
import {randomUUID} from "node:crypto";
import {databasePath} from "./cache.mjs";
import {validateInput} from "./budgets.mjs";

const exec = promisify(execFile);
export const targetPath = () => join(dirname(databasePath()), "target.json");

export function parseEnterpriseUrl(value) {
    let url;
    try { url = new URL(typeof value === "string" ? value.trim() : ""); }
    catch { throw new Error("Enter a full HTTPS enterprise URL, such as https://github.com/enterprises/example-enterprise."); }
    const match = url.pathname.match(/^\/enterprises\/([a-zA-Z0-9][a-zA-Z0-9-]{0,99})\/?$/);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash ||
        !(url.hostname === "github.com" || /^[a-z0-9][a-z0-9-]*\.ghe\.com$/.test(url.hostname)) || !match) {
        throw new Error("Use https://github.com/enterprises/SLUG or https://TENANT.ghe.com/enterprises/SLUG, without credentials or extra parameters.");
    }
    return validateInput({enterprise: match[1], host: url.hostname});
}

export async function readTarget(path = targetPath()) {
    try { return validateInput(JSON.parse(await readFile(path, "utf8"))); }
    catch (error) {
        if (error.code === "ENOENT") return null;
        throw new Error("Could not read the saved enterprise target. Enter the enterprise URL to reconnect.", {cause: error});
    }
}

export async function saveTarget(config, path = targetPath()) {
    const target = validateInput(config);
    await mkdir(dirname(path), {recursive: true, mode: 0o700});
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, `${JSON.stringify(target)}\n`, {mode: 0o600, flag: "wx"});
        await rename(temporary, path);
    } finally { await rm(temporary, {force: true}); }
}

export async function cliStatus(run = exec) {
    try {
        const {stdout} = await run("gh", ["--version"], {timeout: 10000, maxBuffer: 16384});
        return {installed: true, version: stdout.split("\n")[0], error: null};
    } catch (error) {
        return {installed: false, version: null, error: error.code === "ENOENT"
            ? "GitHub CLI is not installed or is not on PATH."
            : "GitHub CLI could not run. Check its installation and executable permissions."};
    }
}

export function canLoadOverview(connection) {
    return connection?.cache.source === "live" && !connection.cache.error &&
        ["authentication", "budgets"].every(key => connection.data.checks.some(check => check.key === key && check.state === "accessible"));
}
