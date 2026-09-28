// Fresh SQLite database for every test run, migrated exactly like production.
import { spawnSync } from "node:child_process";
import { rmSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

export default function setup() {
  const serverDir = resolve(__dirname, "..");
  const dataDir = resolve(serverDir, ".test-data");
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  const env = { ...process.env, DATABASE_URL: "file:" + resolve(dataDir, "nova.db").replace(/\\/g, "/") };
  const r = spawnSync(process.execPath, [resolve(serverDir, "scripts/prisma.mjs"), "migrate", "deploy"], { env, cwd: serverDir, encoding: "utf8" });
  if (r.status !== 0) throw new Error("migrate deploy failed:\n" + r.stdout + r.stderr);
}
