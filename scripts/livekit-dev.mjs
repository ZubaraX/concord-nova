// Local voice server for development: downloads the LiveKit SFU binary for
// this OS (once, into .livekit/) and runs it in --dev mode with webhooks
// pointed at the local API server. Usage: npm run dev:livekit
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, ".livekit");
const exe = join(dir, process.platform === "win32" ? "livekit-server.exe" : "livekit-server");
const apiPort = process.env.PORT ?? "4000";

const FALLBACK_VERSION = "1.13.7";

/** Latest tag via the releases page redirect (not subject to API rate limits). */
async function latestVersion() {
  try {
    const r = await fetch("https://github.com/livekit/livekit/releases/latest", { redirect: "manual", headers: { "user-agent": "concord-nova" } });
    const m = /\/tag\/v([\d.]+)/.exec(r.headers.get("location") ?? "");
    if (m) return m[1];
  } catch {
    /* offline or blocked — use the pinned version */
  }
  return FALLBACK_VERSION;
}

async function download() {
  mkdirSync(dir, { recursive: true });
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  const version = process.env.LIVEKIT_VERSION ?? (await latestVersion());
  const name = `livekit_${version}_${os}_${arch}.${os === "windows" ? "zip" : "tar.gz"}`;
  const archive = join(dir, name);
  console.log(`[livekit] downloading ${name}…`);
  const res = await fetch(`https://github.com/livekit/livekit/releases/download/v${version}/${name}`);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(archive));
  // bsdtar extracts both .zip and .tar.gz. On Windows call the system one
  // explicitly — a GNU tar from Git Bash on PATH can't read zips and treats
  // "C:" as a remote host.
  const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  const r = spawnSync(tar, ["-xf", name], { stdio: "inherit", cwd: dir });
  if (r.status !== 0) throw new Error("extract failed");
  if (!existsSync(exe)) throw new Error(`binary not found after extract: ${exe}`);
}

if (!existsSync(exe)) await download();

const config = join(dir, "livekit.yaml");
writeFileSync(
  config,
  `port: 7880
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50200
  use_external_ip: false
keys:
  devkey: secret
webhook:
  api_key: devkey
  urls:
    - http://127.0.0.1:${apiPort}/api/voice/webhook
logging:
  level: info
`
);

console.log("[livekit] starting on ws://localhost:7880 (key devkey / secret)");
const child = spawn(exe, ["--dev", "--config", config, "--bind", "0.0.0.0"], { stdio: "inherit" });
const stop = () => child.kill("SIGINT");
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code) => process.exit(code ?? 0));
