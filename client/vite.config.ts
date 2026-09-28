import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
// Every build gets an id, written to dist/build.json too: the server reports the
// one it serves, and open web tabs from an older build offer a reload.
const buildId = `${pkg.version}-${Date.now().toString(36)}`;
const buildInfo: Plugin = {
  name: "nova-build-id",
  apply: "build",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "build.json", source: JSON.stringify({ id: buildId, version: pkg.version }) });
  },
};

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss(), buildInfo],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __NOVA_BUILD__: command === "build" ? JSON.stringify(buildId) : "null",
    __APP_BUILD__: JSON.stringify(Number(process.env.NOVA_BUILD_NUMBER) || 0),
  },
  // Relative base: the same build loads from https:// (web), file:// (Electron)
  // and http://localhost (Android WebView).
  base: "./",
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/api": { target: "http://localhost:4000", changeOrigin: true },
      "/files": { target: "http://localhost:4000", changeOrigin: true },
      "/media-proxy": { target: "http://localhost:4000", changeOrigin: true },
      "/socket.io": { target: "http://localhost:4000", ws: true, changeOrigin: true },
    },
  },
  build: {
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          livekit: ["livekit-client"],
          motion: ["motion"],
        },
      },
    },
  },
}));
