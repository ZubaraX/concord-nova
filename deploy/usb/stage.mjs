// Concord Nova — the files of the server USB stick, laid over the Ubuntu Server
// 24.04 ISO's own (make-usb.ps1 writes both to the stick; the CI test installs
// from these on a fresh Ubuntu):
//   autoinstall.yaml    the installer's answers (+ the SSH key of the computer the stick is made on)
//   boot/grub/grub.cfg  the boot menu
//   nova/               the first-boot install: scripts, units, the sources (git HEAD),
//                       Node.js and LiveKit for Linux (checked against their published sums)
//   ПРОЧТИ.txt          what to do with the stick
//
//   node deploy/usb/stage.mjs [--out DIR] [--cache DIR] [--key FILE.pub]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const OUT = resolve(arg("out", join(HERE, ".cache", "stage")));
const CACHE = resolve(arg("cache", join(HERE, ".cache")));
const KEY = arg("key");

const lf = (s) => s.replace(/\r\n/g, "\n");
const crlf = (s) => lf(s).replace(/\n/g, "\r\n");
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

async function get(url, opts) {
  const r = await fetch(url, { headers: { "user-agent": "concord-nova-usb" }, ...opts });
  if (!r.ok && !(opts?.redirect === "manual" && r.status >= 300 && r.status < 400)) throw new Error(`${url}: HTTP ${r.status}`);
  return r;
}

/** A file into the cache, unless it's there already with the right sum. */
async function fetchChecked(url, name, sum) {
  const file = join(CACHE, name);
  if (existsSync(file) && sha256(file) === sum) return file;
  console.log(`  ↓ ${name}`);
  writeFileSync(file, Buffer.from(await (await get(url)).arrayBuffer()));
  if (sha256(file) !== sum) throw new Error(`${name}: checksum mismatch`);
  return file;
}

/** The newest Node.js 24 and LiveKit for Linux x64. */
async function runtime() {
  mkdirSync(CACHE, { recursive: true });
  const sums = await (await get("https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt")).text();
  const [nodeSum, nodeName] = sums
    .split("\n")
    .find((l) => l.trim().endsWith("-linux-x64.tar.xz"))
    .trim()
    .split(/\s+/);
  const node = await fetchChecked(`https://nodejs.org/dist/latest-v24.x/${nodeName}`, nodeName, nodeSum);

  const latest = await get("https://github.com/livekit/livekit/releases/latest", { redirect: "manual" });
  const ver = (latest.headers.get("location") ?? "").replace(/.*\/v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(ver)) throw new Error(`LiveKit: no version in ${latest.headers.get("location")}`);
  const lkName = `livekit_${ver}_linux_amd64.tar.gz`;
  const base = `https://github.com/livekit/livekit/releases/download/v${ver}`;
  const lkSum = (await (await get(`${base}/checksums.txt`)).text())
    .split("\n")
    .find((l) => l.trim().endsWith(lkName))
    ?.split(/\s+/)[0];
  if (!lkSum) throw new Error(`LiveKit ${ver}: ${lkName} is not in checksums.txt`);
  const livekit = await fetchChecked(`${base}/${lkName}`, lkName, lkSum);
  return { node, livekit, versions: `node ${nodeName.match(/v[\d.]+/)[0]}, livekit ${ver}` };
}

console.log(`Concord Nova USB → ${OUT}`);
rmSync(OUT, { recursive: true, force: true });
const nova = join(OUT, "nova");
mkdirSync(join(nova, "runtime"), { recursive: true });
mkdirSync(join(OUT, "boot", "grub"), { recursive: true });

// The installer's answers, with this computer's SSH key for the administrator.
let auto = lf(readFileSync(join(HERE, "autoinstall.yaml"), "utf8"));
if (KEY) {
  const key = readFileSync(KEY, "utf8").trim();
  if (!/^ssh-(ed25519|rsa) [A-Za-z0-9+/=]+( .*)?$/.test(key)) throw new Error(`${KEY}: not an SSH public key`);
  auto = auto.replace("    authorized-keys: []", `    authorized-keys:\n      - ${key}`);
}
writeFileSync(join(OUT, "autoinstall.yaml"), auto);
writeFileSync(join(OUT, "boot", "grub", "grub.cfg"), lf(readFileSync(join(HERE, "grub.cfg"), "utf8")));
writeFileSync(join(OUT, "ПРОЧТИ.txt"), crlf(readFileSync(join(HERE, "ПРОЧТИ.txt"), "utf8")));

// The first-boot install.
for (const f of readdirSync(join(HERE, "nova"))) writeFileSync(join(nova, f), lf(readFileSync(join(HERE, "nova", f), "utf8")));
execFileSync("git", ["-C", ROOT, "archive", "--format=tar.gz", "-o", join(nova, "src.tar.gz"), "HEAD"]);
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const commit = execFileSync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"]).toString().trim();
const { node, livekit, versions } = await runtime();
copyFileSync(node, join(nova, "runtime", node.split(/[\\/]/).pop()));
copyFileSync(livekit, join(nova, "runtime", livekit.split(/[\\/]/).pop()));
writeFileSync(join(nova, "VERSION"), `Concord Nova ${version} (${commit}); ${versions}; stick made ${new Date().toISOString()}\n`);
console.log(`  ✓ Concord Nova ${version} (${commit}), ${versions}${KEY ? ", SSH key added" : ""}`);
