// One command from sources to an installable APK (works on Windows/macOS/Linux):
//   node scripts/android-build.mjs [--release] [--skip-web]
// Builds the web client, generates the Capacitor project if missing, applies
// scripts/android-prepare.mjs, syncs and runs Gradle. The APK lands in
// client/release/. Needs JDK 21 (Android Studio's bundled JBR is picked up
// automatically) and the Android SDK.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const client = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const release = process.argv.includes("--release");
const win = process.platform === "win32";

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (!env.JAVA_HOME) {
  const jbr = [
    "C:/Program Files/Android/Android Studio/jbr",
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
    "/opt/android-studio/jbr",
  ].find((p) => existsSync(p));
  if (jbr) env.JAVA_HOME = jbr;
}

function run(cmd, args, cwd = client) {
  console.log(`\n▶ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd, env, stdio: "inherit", shell: win });
  if (r.status !== 0) {
    console.error(`✖ ${cmd} failed (${r.status ?? r.signal})`);
    process.exit(r.status || 1);
  }
}

if (!process.argv.includes("--skip-web")) run("npx", ["vite", "build"]);
if (!existsSync(join(client, "android"))) run("npx", ["cap", "add", "android"]);
run("node", ["scripts/android-prepare.mjs"]);
run("npx", ["cap", "sync", "android"]);
const buildDir = join(client, "android");
// Absolute path: cmd.exe may be told not to search the current directory.
const gradlew = join(buildDir, win ? "gradlew.bat" : "gradlew");
if (!win) chmodSync(gradlew, 0o755);
run(win ? `"${gradlew}"` : gradlew, [release ? "assembleRelease" : "assembleDebug", "--no-daemon"], buildDir);

const variant = release ? "release" : "debug";
const dir = join(client, "android/app/build/outputs/apk", variant);
const built = [`app-${variant}.apk`, `app-${variant}-unsigned.apk`].map((f) => join(dir, f)).find(existsSync);
if (!built) {
  console.error(`✖ APK not found in ${dir}`);
  process.exit(1);
}
const version = JSON.parse(readFileSync(join(client, "package.json"), "utf8")).version;
mkdirSync(join(client, "release"), { recursive: true });
const out = join(client, "release", `ConcordNova-${version}${release ? "" : "-debug"}.apk`);
copyFileSync(built, out);
console.log(`\n✅ ${out}${built.endsWith("unsigned.apk") ? "  (unsigned — set NOVA_KEYSTORE to sign)" : ""}`);
