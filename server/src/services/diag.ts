// Diagnostic logs from the apps: what happened in calls and connections on
// someone's device (no messages, no audio). Kept per user under
// <dataDir>/diag — outside the uploads, so nothing serves them publicly — and
// read by instance admins, who can download them to look into a problem.
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "../config";
import { prisma } from "../db";

const dir = resolve(config.dataDir, "diag");
/** Past this a file is cut down to its newer half. */
const MAX_FILE = 1024 * 1024;

const fileOf = (userId: string) => resolve(dir, `${userId}.log`);

export async function appendDiag(userId: string, client: string, lines: string[]) {
  await mkdir(dir, { recursive: true });
  const file = fileOf(userId);
  const head = `--- ${new Date().toISOString()} ${client}\n`;
  await appendFile(file, head + lines.map((l) => l.replace(/[\r\n]+/g, " ") + "\n").join(""));
  const size = (await stat(file)).size;
  if (size > MAX_FILE) {
    const text = await readFile(file, "utf8");
    const cut = text.indexOf("\n--- ", text.length - MAX_FILE / 2);
    await writeFile(file, cut > 0 ? text.slice(cut + 1) : text.slice(-MAX_FILE / 2));
  }
}

export interface DiagFile {
  userId: string;
  name: string;
  size: number;
  updatedAt: string;
}

export async function listDiag(): Promise<DiagFile[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const files = await Promise.all(
    names
      .filter((n) => /^[0-9A-HJKMNP-TV-Z]{26}\.log$/.test(n))
      .map(async (n) => ({ userId: n.slice(0, 26), st: await stat(resolve(dir, n)).catch(() => null) }))
  );
  const present = files.filter((f) => f.st);
  const users = await prisma.user.findMany({ where: { id: { in: present.map((f) => f.userId) } }, select: { id: true, username: true, displayName: true } });
  const nameOf = new Map(users.map((u) => [u.id, u.displayName || u.username]));
  return present
    .map((f) => ({ userId: f.userId, name: nameOf.get(f.userId) ?? f.userId, size: f.st!.size, updatedAt: f.st!.mtime.toISOString() }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readDiag(userId: string): Promise<string | null> {
  return readFile(fileOf(userId), "utf8").catch(() => null);
}
