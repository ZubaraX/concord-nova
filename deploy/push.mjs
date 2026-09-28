// Deploy this source tree to your server in one step (run on your PC):
//
//   node deploy/push.mjs root@138.16.224.172 --purge-old
//
// Packs the sources (no node_modules / builds / local data), streams them over
// SSH and runs deploy/setup.sh on the server. Uses the system `ssh` (built into
// Windows 10+, macOS, Linux): you type the server password once — or nothing,
// with an SSH key (recommended: ssh-copy-id, then disable password login).
//
// Options:
//   --purge-old        remove the old Concord (archived to /root first, data imported)
//   --no-migrate       with --purge-old: don't import the old accounts/messages
//   --domain <name>    HTTPS name (default: <ip-with-dashes>.sslip.io)
//   --email <addr>     Let's Encrypt contact
//   --port <n>         SSH port (default 22)
//   --dry-run          write the archive to the temp dir and print what would run
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const target = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1]?.match(/^--(domain|email|port)$/) == null);
const opt = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (!target || !target.includes("@")) {
  console.error("usage: node deploy/push.mjs <user@host> [--purge-old] [--no-migrate] [--domain name] [--email addr] [--port n] [--dry-run]");
  process.exit(1);
}

// ── collect files ─────────────────────────────────────────────────────────────
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "dist-electron", "release", ".livekit", ".playwright-mcp", ".test-data", "data", "coverage", ".gradle", "build-output"]);
const SKIP_PATHS = new Set(["client/android", "client/build/.cache"]);
const SKIP_FILE = (name) => name === ".env" || /\.db(-journal|-wal|-shm)?$/.test(name) || name.endsWith(".log");
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    const rel = relative(root, full).split(sep).join("/");
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !SKIP_PATHS.has(rel)) walk(full);
    } else if (e.isFile() && !SKIP_FILE(e.name)) files.push(rel);
  }
})(root);

// ── minimal ustar writer (no dependence on the local `tar` flavour) ──────────
function header(name, size, mode) {
  const h = Buffer.alloc(512);
  let prefix = "";
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/", 155);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
    if (Buffer.byteLength(base) > 100 || Buffer.byteLength(prefix) > 155) throw new Error(`path too long for tar: ${name}`);
  }
  const put = (s, off, len) => h.write(s, off, len, "utf8");
  const oct = (n, len) => n.toString(8).padStart(len - 1, "0") + "\0";
  put(base, 0, 100);
  put(oct(mode, 8), 100, 8);
  put(oct(0, 8), 108, 8);
  put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12);
  put(oct(Math.floor(Date.now() / 1000), 12), 136, 12);
  put("        ", 148, 8);
  put("0", 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}
const parts = [];
let bytes = 0;
for (const rel of files) {
  const data = readFileSync(join(root, rel));
  const exec = rel.endsWith(".sh") || rel.endsWith("gradlew");
  parts.push(header(rel, data.length, exec ? 0o755 : 0o644), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  bytes += data.length;
}
parts.push(Buffer.alloc(1024));
const archive = gzipSync(Buffer.concat(parts), { level: 9 });
console.log(`▶ ${files.length} files, ${(bytes / 1048576).toFixed(1)} MB → ${(archive.length / 1048576).toFixed(1)} MB archive`);

// ── remote command ───────────────────────────────────────────────────────────
const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
const env = [];
if (argv.includes("--purge-old")) env.push("PURGE_OLD=1");
if (argv.includes("--no-migrate")) env.push("MIGRATE_OLD=0");
if (opt("domain")) env.push(`DOMAIN=${q(opt("domain"))}`);
if (opt("email")) env.push(`EMAIL=${q(opt("email"))}`);
const remote = [
  "set -e",
  "rm -rf /root/nova-deploy && mkdir -p /root/nova-deploy",
  "tar -xzf - -C /root/nova-deploy",
  `${env.join(" ")} bash /root/nova-deploy/deploy/setup.sh`,
  "rm -rf /root/nova-deploy",
].join("; ");

const sshArgs = ["-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=30"];
if (opt("port")) sshArgs.push("-p", opt("port"));
sshArgs.push(target, remote);

if (argv.includes("--dry-run")) {
  const out = join(tmpdir(), "nova-src.tar.gz");
  writeFileSync(out, archive);
  console.log(`archive: ${out}\nssh ${sshArgs.map((a) => (/\s/.test(a) ? q(a) : a)).join(" ")}`);
  process.exit(0);
}
console.log(`▶ uploading to ${target} and running deploy/setup.sh${env.length ? ` (${env.join(" ")})` : ""}…\n`);
const ssh = spawn("ssh", sshArgs, { stdio: ["pipe", "inherit", "inherit"] });
ssh.stdin.end(archive);
ssh.on("error", (e) => {
  console.error(`✖ could not start ssh: ${e.message}`);
  process.exit(1);
});
ssh.on("exit", (code) => {
  if (code === 0) console.log("\n✅ deployed");
  else console.error(`\n✖ remote setup exited with ${code} — see the output above`);
  process.exit(code ?? 1);
});
