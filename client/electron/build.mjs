// Bundles the Electron main + preload into dist-electron/ (electron-updater
// inlined) so the packaged app needs no node_modules at all.
import { build } from "esbuild";
import { buildNative } from "../scripts/build-native.mjs";

buildNative();

const common = { bundle: true, platform: "node", target: "node20", format: "cjs", external: ["electron"], logLevel: "info" };
await build({ ...common, entryPoints: ["electron/main.cjs"], outfile: "dist-electron/main.cjs" });
await build({ ...common, entryPoints: ["electron/preload.cjs"], outfile: "dist-electron/preload.cjs" });
await build({ ...common, entryPoints: ["electron/music-preload.cjs"], outfile: "dist-electron/music-preload.cjs" });
