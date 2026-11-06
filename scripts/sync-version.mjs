import {readFile, writeFile} from "node:fs/promises";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const plugin = JSON.parse(await readFile("plugin.json", "utf8"));
plugin.version = pkg.version;
await writeFile("plugin.json", `${JSON.stringify(plugin, null, 2)}\n`);
