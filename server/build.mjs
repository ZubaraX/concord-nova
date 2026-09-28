// Bundles the server into dist/index.js. Workspace code (@nova/shared) is
// inlined; real npm dependencies stay external and load from node_modules.
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const external = Object.keys(pkg.dependencies).filter((d) => !d.startsWith("@nova/"));

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  external: [...external, ...external.map((d) => `${d}/*`)],
  banner: {
    // Some CJS deps expect require() in ESM output.
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  define: { "process.env.NOVA_VERSION": JSON.stringify(pkg.version) },
  logLevel: "info",
});
