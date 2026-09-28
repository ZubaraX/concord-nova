// Centralized, validated configuration (env-driven). Loads the repo-root .env.
import { z } from "zod";
import dotenv from "dotenv";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// src/ in dev (tsx), dist/ when bundled — both sit directly under server/.
export const SERVER_DIR = resolve(here, "..");
export const REPO_ROOT = resolve(SERVER_DIR, "..");

dotenv.config({ path: resolve(REPO_ROOT, ".env"), quiet: true });

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().default(4000),
  /** Public base URL (https://chat.example.com) — used in invite links. */
  PUBLIC_URL: z.string().default(""),
  SERVER_NAME: z.string().default("Concord Nova"),
  TRUST_PROXY: bool.default(false),

  DATA_DIR: z.string().default(""),
  DATABASE_URL: z.string().optional(),
  STORAGE_DIR: z.string().default(""),
  WEB_DIST: z.string().default(""),

  JWT_SECRET: z.string().default(""),
  ACCESS_TOKEN_TTL: z.coerce.number().int().default(900),
  REFRESH_TOKEN_TTL: z.coerce.number().int().default(60 * 86_400),

  /** open | invite (a valid server invite is required) | closed — default; admins can change it in the app. */
  REGISTRATION: z.enum(["open", "invite", "closed"]).default("open"),

  MAX_MESSAGE_LENGTH: z.coerce.number().int().min(100).max(100_000).default(20_000),
  /** 0 = unlimited (bounded by disk). */
  MAX_UPLOAD_BYTES: z.coerce.number().int().min(0).default(0),

  LIVEKIT_URL: z.string().default(""),
  LIVEKIT_INTERNAL_URL: z.string().default("http://127.0.0.1:7880"),
  LIVEKIT_API_KEY: z.string().default(""),
  LIVEKIT_API_SECRET: z.string().default(""),

  KLIPY_KEY: z.string().default(""),
  TENOR_KEY: z.string().default(""),

  SMTP_HOST: z.string().default(""),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),
  SMTP_FROM: z.string().default(""),

  LOG_LEVEL: z.string().default("info"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("✖ Invalid environment configuration:");
  for (const i of parsed.error.issues) console.error(`  ${i.path.join(".")}: ${i.message}`);
  process.exit(1);
}
const env = parsed.data;

const abs = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));
const dataDir = env.DATA_DIR ? abs(env.DATA_DIR) : resolve(REPO_ROOT, "data");
mkdirSync(dataDir, { recursive: true });

// Keep in sync with scripts/prisma.mjs.
if (!env.DATABASE_URL) {
  process.env.DATABASE_URL = "file:" + resolve(dataDir, "nova.db").replace(/\\/g, "/");
}

/**
 * JWT secret: from env, or generated once and persisted next to the database
 * so a fresh install is secure without any manual step, and tokens survive
 * restarts.
 */
function jwtSecret(): string {
  if (env.JWT_SECRET && env.JWT_SECRET.length >= 32) return env.JWT_SECRET;
  if (env.JWT_SECRET) console.warn("⚠ JWT_SECRET is shorter than 32 chars — generating a strong one instead");
  const file = resolve(dataDir, ".jwt-secret");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const s = randomBytes(48).toString("base64url");
  writeFileSync(file, s, { mode: 0o600 });
  return s;
}

const isDev = env.NODE_ENV !== "production";

export const config = {
  ...env,
  isProd: env.NODE_ENV === "production",
  isTest: env.NODE_ENV === "test",
  dataDir,
  storageDir: env.STORAGE_DIR ? abs(env.STORAGE_DIR) : resolve(dataDir, "uploads"),
  cacheDir: resolve(dataDir, "cache"),
  webDist: env.WEB_DIST ? abs(env.WEB_DIST) : resolve(REPO_ROOT, "client", "dist"),
  jwtSecret: jwtSecret(),
  version: process.env.NOVA_VERSION ?? "1.0.0-dev",
  livekit: {
    // `livekit-server --dev` uses devkey/secret — handy defaults for local work.
    apiKey: env.LIVEKIT_API_KEY || (isDev ? "devkey" : ""),
    apiSecret: env.LIVEKIT_API_SECRET || (isDev ? "secret" : ""),
    /** What clients connect to. Empty in prod = same origin (nginx proxies /rtc). */
    publicUrl: env.LIVEKIT_URL || (isDev ? "ws://localhost:7880" : ""),
    internalUrl: env.LIVEKIT_INTERNAL_URL,
  },
};

export type Config = typeof config;
export const voiceEnabled = () => !!(config.livekit.apiKey && config.livekit.apiSecret);
