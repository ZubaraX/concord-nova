import "./config"; // resolves DATABASE_URL before the client is constructed
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient({
  log: process.env.PRISMA_LOG ? ["query", "warn", "error"] : ["warn", "error"],
});

/**
 * SQLite tuning: WAL allows concurrent readers during writes, busy_timeout
 * rides out brief lock contention instead of failing, NORMAL sync is safe with
 * WAL. PRAGMAs that return rows must go through $queryRaw on SQLite.
 */
export async function tuneSqlite() {
  await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL;");
  await prisma.$queryRawUnsafe("PRAGMA busy_timeout=8000;");
  await prisma.$queryRawUnsafe("PRAGMA synchronous=NORMAL;");
  await prisma.$queryRawUnsafe("PRAGMA foreign_keys=ON;");
  await prisma.$queryRawUnsafe("PRAGMA temp_store=MEMORY;");
}

/** JSON column helpers (SQLite stores JSON as TEXT). */
export function jsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
