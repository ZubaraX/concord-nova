// Instance administration: the owner of the Nova server manages accounts,
// servers and instance settings from the app instead of over SSH.
import { randomInt } from "node:crypto";
import { statSync } from "node:fs";
import type { FastifyBaseLogger } from "fastify";
import { UserFlags, type AdminGuildDTO, type AdminOverviewDTO, type AdminUserDTO } from "@nova/shared";
import { prisma } from "../db";
import { config } from "../config";
import { badRequest, notFound } from "../lib/errors";
import { hashPassword, verifyPassword } from "../lib/auth";
import { cache } from "../state/cache";
import { presence } from "../state/presence";
import { voice } from "../state/voice";
import { instance, mailOverview, setInstanceSettings } from "./instance";
import { revokeSession } from "./users";
import { setGuildOwner } from "./guilds";
import { broadcastUserUpdate } from "./audience";

const isAdminFlags = (flags: number) => (flags & UserFlags.INSTANCE_ADMIN) !== 0;

export async function isInstanceAdmin(userId: string): Promise<boolean> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { flags: true, disabledAt: true } });
  return !!u && !u.disabledAt && isAdminFlags(u.flags);
}

async function revokeAll(userId: string, reason: string) {
  const sessions = await prisma.session.findMany({ where: { userId }, select: { id: true } });
  for (const s of sessions) await revokeSession(userId, s.id, reason);
}

// ── startup hygiene ──────────────────────────────────────────────────────────
/**
 * Old Concord deployments seeded demo@concord.dev / password123 — a password
 * published in its repository (the import may have renamed the address to
 * demo+concordN@concord.dev). While such an account keeps that password anybody
 * could sign in as it — and it may own servers or be the first, admin account —
 * so it is disabled and loses admin rights. An admin can re-enable it with a new
 * password from the admin panel.
 */
export async function lockPublicDemoAccount(log: FastifyBaseLogger) {
  const candidates = await prisma.user.findMany({
    where: { disabledAt: null, OR: [{ email: "demo@concord.dev" }, { email: { startsWith: "demo+concord", endsWith: "@concord.dev" } }] },
    select: { id: true, email: true, passwordHash: true, flags: true },
  });
  for (const demo of candidates) {
    if (!(await verifyPassword("password123", demo.passwordHash))) continue;
    await prisma.user.update({
      where: { id: demo.id },
      data: { disabledAt: new Date(), flags: demo.flags & ~UserFlags.INSTANCE_ADMIN, passwordHash: `!locked:${demo.passwordHash}` },
    });
    await revokeAll(demo.id, "account_disabled");
    log.warn(`${demo.email} still had the public password 'password123' — the account was disabled (re-enable it from Settings → Nova server → Users)`);
  }
}

// ── overview ─────────────────────────────────────────────────────────────────
function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export async function overview(): Promise<AdminOverviewDTO> {
  const [users, usersDisabled, admins, guilds, channels, messages, attachments, sum] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { disabledAt: { not: null } } }),
    prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM "User" WHERE ("flags" & ${UserFlags.INSTANCE_ADMIN}) != 0`),
    prisma.guild.count(),
    prisma.channel.count(),
    prisma.message.count(),
    prisma.attachment.count(),
    prisma.attachment.aggregate({ _sum: { size: true } }),
  ]);
  const dbUrl = process.env.DATABASE_URL ?? "";
  const dbPath = dbUrl.startsWith("file:") ? dbUrl.slice(5) : "";
  return {
    version: config.version,
    node: process.version,
    uptimeSec: Math.round(process.uptime()),
    serverName: instance.serverName,
    registration: instance.registration,
    gifKey: instance.gifKey,
    mail: mailOverview(),
    users,
    usersDisabled,
    admins: Number(admins[0]?.n ?? 0),
    guilds,
    channels,
    messages,
    attachments,
    storageBytes: String(sum._sum.size ?? 0n),
    databaseBytes: String(dbPath ? fileSize(dbPath) + fileSize(`${dbPath}-wal`) : 0),
    connected: presence.connectedCount(),
    voice: voice.stats(),
  };
}

// ── users ────────────────────────────────────────────────────────────────────
/** Newest first; `guildId` narrows the list to that server's members (owner transfer). */
export async function listUsers(q: string, guildId?: string): Promise<AdminUserDTO[]> {
  const needle = q.trim();
  const lower = needle.toLowerCase();
  const rows = await prisma.user.findMany({
    where: {
      ...(needle && { OR: [{ username: { contains: lower } }, { email: { contains: lower } }, { displayName: { contains: needle } }, { id: needle }] }),
      ...(guildId && { memberships: { some: { guildId } } }),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true,
      username: true,
      displayName: true,
      email: true,
      avatar: true,
      createdAt: true,
      flags: true,
      disabledAt: true,
      passwordHash: true,
      _count: { select: { memberships: true, sessions: true } },
      sessions: { select: { lastUsedAt: true }, orderBy: { lastUsedAt: "desc" }, take: 1 },
    },
  });
  return rows.map((u) => ({
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    email: u.email,
    avatar: u.avatar,
    createdAt: u.createdAt.toISOString(),
    lastActiveAt: presence.isConnected(u.id) ? new Date().toISOString() : (u.sessions[0]?.lastUsedAt.toISOString() ?? null),
    admin: isAdminFlags(u.flags),
    disabled: !!u.disabledAt,
    passwordLocked: u.passwordHash.startsWith("!"),
    guilds: u._count.memberships,
    sessions: u._count.sessions,
  }));
}

/** A readable one-time password: 3 groups of 4 (no look-alike characters). */
function tempPassword(): string {
  const abc = "abcdefghjkmnpqrstuvwxyz23456789";
  const group = () => Array.from({ length: 4 }, () => abc[randomInt(abc.length)]).join("");
  return `${group()}-${group()}-${group()}`;
}

export async function resetPassword(adminId: string, userId: string): Promise<{ password: string }> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!u) throw notFound("unknown_user");
  const password = tempPassword();
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(password), resetCode: null, resetExpires: null } });
  if (userId !== adminId) await revokeAll(userId, "password_reset");
  return { password };
}

export async function setDisabled(adminId: string, userId: string, disabled: boolean) {
  if (userId === adminId) throw badRequest("cannot_disable_self");
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!u) throw notFound("unknown_user");
  // Re-enabling never restores a password locked for being public ("!locked:…"):
  // such an account needs a password reset before anyone can sign in.
  await prisma.user.update({ where: { id: userId }, data: { disabledAt: disabled ? new Date() : null } });
  if (disabled) await revokeAll(userId, "account_disabled");
}

export async function setAdmin(adminId: string, userId: string, admin: boolean) {
  if (userId === adminId && !admin) throw badRequest("cannot_demote_self");
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { flags: true } });
  if (!u) throw notFound("unknown_user");
  await prisma.user.update({ where: { id: userId }, data: { flags: admin ? u.flags | UserFlags.INSTANCE_ADMIN : u.flags & ~UserFlags.INSTANCE_ADMIN } });
  // Their open apps show (or hide) the admin section right away.
  await broadcastUserUpdate(userId);
}

// ── servers ──────────────────────────────────────────────────────────────────
export async function listGuilds(): Promise<AdminGuildDTO[]> {
  const rows = await prisma.guild.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, icon: true, ownerId: true, createdAt: true, owner: { select: { username: true, displayName: true, disabledAt: true } }, _count: { select: { members: true } } },
  });
  return rows.map((g) => ({
    id: g.id,
    name: g.name,
    icon: g.icon,
    ownerId: g.ownerId,
    ownerName: g.owner.displayName || g.owner.username,
    ownerDisabled: !!g.owner.disabledAt,
    members: g._count.members,
    createdAt: g.createdAt.toISOString(),
  }));
}

export async function transferGuild(guildId: string, userId: string) {
  if (!cache.guild(guildId)) throw notFound("unknown_guild");
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { disabledAt: true } });
  if (!u) throw notFound("unknown_user");
  if (u.disabledAt) throw badRequest("account_disabled");
  await setGuildOwner(guildId, userId);
}

export { setInstanceSettings };
