import { build } from "esbuild";
import {readFile} from "node:fs/promises";
import {installedVersion} from "../extensions/github-finops/updates.mjs";

const read = async path => JSON.parse(await readFile(path, "utf8"));
const [pkg, plugin, lock] = await Promise.all(["package.json", "plugin.json", "package-lock.json"].map(read));
if (![plugin.version, lock.version, lock.packages[""].version, await installedVersion()].every(version => version === pkg.version)) {
    throw new Error("Version mismatch: synchronize VERSION, plugin.json and package-lock.json using npm version before building.");
}

await build({
    entryPoints: ["extensions/github-finops/ui/main.tsx"],
    bundle: true,
    minify: true,
    sourcemap: false,
    target: ["es2022"],
    outfile: "extensions/github-finops/assets/app.js",
    define: { "process.env.NODE_ENV": '"production"' },
    legalComments: "external",
});
