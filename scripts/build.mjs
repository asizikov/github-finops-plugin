import { build } from "esbuild";
import {readFile} from "node:fs/promises";

const read = async path => JSON.parse(await readFile(path, "utf8"));
const [pkg, plugin, lock] = await Promise.all(["package.json", "plugin.json", "package-lock.json"].map(read));
if (![plugin.version, lock.version, lock.packages[""].version].every(version => version === pkg.version)) {
    throw new Error("Version mismatch: synchronize plugin.json and package-lock.json with package.json before building.");
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
