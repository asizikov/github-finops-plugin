import { build } from "esbuild";

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
