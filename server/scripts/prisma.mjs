// Runs the Prisma CLI with DATABASE_URL resolved exactly like the server does
// (repo-root .env, default database in <repo>/data/nova.db), so migrations and
// the running server can never point at different files.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(here, "..");
const repoRoot = resolve(serverDir, "..");
dotenv.config({ path: resolve(repoRoot, ".env"), quiet: true });

// Keep in sync with src/config.ts (resolveDatabaseUrl).
if (!process.env.DATABASE_URL) {
  const raw = process.env.DATA_DIR;
  const dataDir = raw ? (isAbsolute(raw) ? raw : resolve(repoRoot, raw)) : resolve(repoRoot, "data");
  mkdirSync(dataDir, { recursive: true });
  process.env.DATABASE_URL = "file:" + resolve(dataDir, "nova.db").replace(/\\/g, "/");
}

const require = createRequire(import.meta.url);
let cli;
try {
  cli = require.resolve("prisma/build/index.js");
} catch {
  console.error("prisma CLI not installed — run npm install");
  process.exit(1);
}
const schema = resolve(serverDir, "prisma", "schema.prisma");
if (!existsSync(schema)) {
  console.error("missing", schema);
  process.exit(1);
}

const args = process.argv.slice(2);
const needsSchema = !args.includes("--schema") && ["generate", "migrate", "studio", "db", "validate", "format"].includes(args[0]);
const res = spawnSync(process.execPath, [cli, ...args, ...(needsSchema ? ["--schema", schema] : [])], {
  stdio: "inherit",
  env: process.env,
  cwd: serverDir,
});
process.exit(res.status ?? 1);
