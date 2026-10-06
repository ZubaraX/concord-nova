// Builds the Windows screen-share audio helper (native/loopback) into
// native/bin/nova-loopback.exe, which electron-builder ships as a resource.
// Uses MSVC when it can find it (GitHub's Windows runners, Visual Studio),
// otherwise a MinGW clang++/g++ on PATH. Without a compiler the app still
// works: screen share then falls back to plain system-audio loopback.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "native", "loopback", "nova-loopback.cpp");
const outDir = join(root, "native", "bin");
const out = join(outDir, "nova-loopback.exe");


const has = (cmd) => spawnSync("where", [cmd], { stdio: "ignore" }).status === 0;

function msvc() {
  const vswhere = join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
  let vcvars = null;
  if (existsSync(vswhere)) {
    const path = execFileSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8" }).trim();
    if (path) vcvars = join(path, "VC", "Auxiliary", "Build", "vcvars64.bat");
  }
  const cl = `cl /nologo /O2 /EHsc /std:c++17 /MT "${src}" /Fe:"${out}" /Fo:"${join(outDir, "nova-loopback.obj")}" ole32.lib mmdevapi.lib user32.lib`;
  if (has("cl")) return spawnSync(cl, { shell: true, stdio: "inherit" }).status === 0;
  if (vcvars && existsSync(vcvars)) return spawnSync(`call "${vcvars}" >nul && ${cl}`, { shell: true, stdio: "inherit" }).status === 0;
  return false;
}

function mingw() {
  const cxx = ["clang++", "g++"].find(has);
  if (!cxx) return false;
  return spawnSync(cxx, ["-O2", "-std=c++17", "-municode", "-static", src, "-o", out, "-lole32", "-lmmdevapi", "-luuid", "-luser32"], { stdio: "inherit" }).status === 0;
}

/** Imported by electron/build.mjs; also runs on its own (node scripts/build-native.mjs). */
export function buildNative() {
  if (process.platform !== "win32") return console.log("[native] not Windows — skipping nova-loopback");
  if (existsSync(out) && statSync(out).mtimeMs > statSync(src).mtimeMs) return console.log("[native] nova-loopback.exe is up to date");
  mkdirSync(outDir, { recursive: true });
  if (msvc() || mingw()) {
    rmSync(join(outDir, "nova-loopback.obj"), { force: true });
    console.log(`[native] built ${out}`);
  } else {
    console.warn("[native] no C++ compiler found — nova-loopback.exe not built (screen share audio falls back to plain loopback)");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildNative();
