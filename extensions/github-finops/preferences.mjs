import {readFile, mkdir, writeFile, rename, rm} from "node:fs/promises";
import {dirname, join} from "node:path";
import {createHash, randomUUID} from "node:crypto";
import {databasePath} from "./cache.mjs";
import {validateInput} from "./budgets.mjs";

// User-local UI preferences, stored beside the cache (never in the repo). One file per
// host/enterprise, so canvases for different targets never read-modify-write the same file.
export const preferencesPath = () => join(dirname(databasePath()), "preferences");
export const targetFile = (directory, key) => join(directory, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`);

const MAX_BYTES = 64 * 1024;
const SKU_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/;

export function validateBudgetSku(value) {
    if (value === null) return null;
    if (typeof value !== "string" || !SKU_PATTERN.test(value)) throw new Error("Invalid budget SKU filter.");
    return value;
}

const targetKey = config => {
    const {host, enterprise} = validateInput(config);
    return `${host.toLowerCase()}/${enterprise.toLowerCase()}`;
};

async function readTarget(path, key) {
    let text;
    try { text = await readFile(path, "utf8"); }
    catch (error) {
        if (error.code === "ENOENT") return {version: 1, target: key};
        throw error;
    }
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("Saved preferences are too large.");
    const saved = JSON.parse(text);
    if (saved?.version !== 1 || saved.target !== key || typeof saved !== "object" || Array.isArray(saved)) {
        throw new Error("Saved preferences have an unexpected format.");
    }
    return saved;
}

function view(entry) {
    const budgetSku = entry.budgetSku ?? null;
    try { return {budgetSku: validateBudgetSku(budgetSku)}; }
    catch { throw new Error("The saved budget SKU filter is malformed."); }
}

export function createPreferences({path = preferencesPath} = {}) {
    let queue = Promise.resolve();
    const resolvePath = () => typeof path === "function" ? path() : path;
    return {
        async read(config) {
            const key = targetKey(config);
            try { return view(await readTarget(targetFile(resolvePath(), key), key)); }
            catch (error) {
                console.error("Preferences read failed:", error);
                const malformed = /malformed/.test(error.message);
                throw Object.assign(new Error("Could not read saved preferences."), {publicMessage: malformed
                    ? `${error.message} Showing all SKUs; choose a SKU to replace it.`
                    : "Could not read saved preferences. Showing all SKUs; changes cannot be saved until the preferences file is readable."});
            }
        },
        update(config, changes) {
            let key;
            const next = {};
            try {
                key = targetKey(config);
                if (Object.hasOwn(changes ?? {}, "budgetSku")) next.budgetSku = validateBudgetSku(changes.budgetSku);
            } catch (error) { return Promise.reject(error); }
            if (!Object.keys(next).length) return Promise.reject(new Error("No supported preference changes."));
            const run = queue.then(async () => {
                const file = targetFile(resolvePath(), key);
                let saved;
                try { saved = await readTarget(file, key); }
                catch (error) {
                    console.error("Preferences read before save failed; existing file left unchanged:", error);
                    throw Object.assign(new Error("Could not read saved preferences, so the choice was not saved."),
                        {status: 500, publicMessage: "Could not read saved preferences, so the choice was not saved. The existing preferences file was left unchanged."});
                }
                Object.assign(saved, next);
                await mkdir(dirname(file), {recursive: true, mode: 0o700});
                const temporary = `${file}.${randomUUID()}.tmp`;
                try {
                    await writeFile(temporary, `${JSON.stringify(saved)}\n`, {mode: 0o600, flag: "wx"});
                    await rename(temporary, file);
                } finally { await rm(temporary, {force: true}); }
                return {budgetSku: saved.budgetSku ?? null};
            });
            queue = run.catch(() => {});
            return run;
        },
    };
}
