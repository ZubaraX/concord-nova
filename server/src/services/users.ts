import {
  RelationshipType,
  type ChosenStatus,
  type CustomStatus,
  type NotificationSettingDTO,
  type NotificationLevel,
  type ProfileDTO,
  type SessionDTO,
} from "@nova/shared";
import type { z } from "zod";
import type { accountUpdateSchema, notificationSettingSchema, profileUpdateSchema } from "@nova/shared";
import { prisma, jsonParse } from "../db";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { forgetSession, hashPassword, verifyPassword } from "../lib/auth";
import { cache } from "../state/cache";
import { presence } from "../state/presence";
import { disconnectSession, toUser } from "../gateway/io";
import { closeSessionStreams } from "./push";
import { broadcastPresence, broadcastUserUpdate } from "./audience";
import { memberInclude, profileSelect, toMember, toProfile, toSelf } from "./serialize";

export async function getSelf(userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId } });
  if (!u) throw notFound("unknown_user");
  return toSelf(u);
}

export async function updateProfile(userId: string, input: z.output<typeof profileUpdateSchema>) {
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) if (v !== undefined) data[k] = typeof v === "string" && k !== "avatar" && k !== "banner" ? v.trim() || null : v;
  await prisma.user.update({ where: { id: userId }, data });
  await broadcastUserUpdate(userId);
  return getSelf(userId);
}

export async function updateAccount(userId: string, sid: string, input: z.output<typeof accountUpdateSchema>) {
  const u = await prisma.user.findUnique({ where: { id: userId } });
  if (!u) throw notFound("unknown_user");
  if (!(await verifyPassword(input.password, u.passwordHash))) throw forbidden("wrong_password");
  const data: Record<string, unknown> = {};
  if (input.username && input.username !== u.username) {
    if (await prisma.user.findUnique({ where: { username: input.username } })) throw conflict("username_taken");
    data.username = input.username;
  }
  if (input.email && input.email !== u.email) {
    if (await prisma.user.findUnique({ where: { email: input.email } })) throw conflict("email_taken");
    data.email = input.email;
  }
  if (input.newPassword) data.passwordHash = await hashPassword(input.newPassword);
  if (!Object.keys(data).length) return getSelf(userId);
  await prisma.user.update({ where: { id: userId }, data });
  // A new password signs out every other device.
  if (input.newPassword) await revokeOtherSessions(userId, sid);
  await broadcastUserUpdate(userId);
  return getSelf(userId);
}

export async function getSettings(userId: string): Promise<Record<string, unknown>> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { settings: true } });
  return jsonParse<Record<string, unknown>>(u?.settings, {});
}

export async function putSettings(userId: string, settings: Record<string, unknown>) {
  const json = JSON.stringify(settings);
  if (json.length > 64_000) throw badRequest("settings_too_large");
  await prisma.user.update({ where: { id: userId }, data: { settings: json } });
  toUser(userId, "USER_SETTINGS_UPDATE", { settings });
}

export async function setStatus(userId: string, input: { status?: ChosenStatus; customStatus?: CustomStatus | null }) {
  const data: Record<string, unknown> = {};
  if (input.status) {
    data.status = input.status;
    presence.setChosen(userId, input.status);
  }
  if (input.customStatus !== undefined) {
    const c = input.customStatus;
    const empty = !c || (!c.text && !c.emoji);
    data.customStatusText = empty ? null : c!.text;
    data.customStatusEmoji = empty ? null : c!.emoji;
    data.customStatusExpires = empty || !c!.expiresAt ? null : new Date(c!.expiresAt);
    presence.setCustom(userId, empty ? null : c!);
  }
  if (!Object.keys(data).length) return getSelf(userId);
  await prisma.user.update({ where: { id: userId }, data });
  const self = await getSelf(userId);
  toUser(userId, "SELF_UPDATE", self);
  await broadcastPresence(userId);
  return self;
}

export async function getProfile(viewerId: string, userId: string, guildId?: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: profileSelect });
  if (!u) throw notFound("unknown_user");
  const mutualGuilds = cache.userGuildIds(viewerId).filter((g) => cache.isMember(g, userId));
  const [mineFriends, theirFriends, rel] = await Promise.all([
    prisma.relationship.findMany({ where: { userId: viewerId, type: RelationshipType.FRIEND }, select: { targetId: true } }),
    prisma.relationship.findMany({ where: { userId, type: RelationshipType.FRIEND }, select: { targetId: true } }),
    prisma.relationship.findUnique({ where: { userId_targetId: { userId: viewerId, targetId: userId } } }),
  ]);
  const theirs = new Set(theirFriends.map((f) => f.targetId));
  const member =
    guildId && cache.isMember(guildId, viewerId)
      ? await prisma.member.findUnique({ where: { guildId_userId: { guildId, userId } }, include: memberInclude })
      : null;
  const profile: ProfileDTO = toProfile(u);
  return {
    user: profile,
    mutualGuilds,
    mutualFriends: viewerId === userId ? [] : mineFriends.map((f) => f.targetId).filter((id) => theirs.has(id)),
    relationship: rel?.type ?? null,
    member: member ? toMember(member) : null,
  };
}

// ── notification settings ────────────────────────────────────────────────────
function toNotif(r: { targetId: string; level: string; muted: boolean; muteUntil: Date | null; suppressEveryone: boolean }): NotificationSettingDTO {
  return {
    targetId: r.targetId,
    level: (["default", "all", "mentions", "none"].includes(r.level) ? r.level : "default") as NotificationLevel,
    muted: r.muted && (!r.muteUntil || r.muteUntil.getTime() > Date.now()),
    muteUntil: r.muteUntil?.getTime() ?? null,
    suppressEveryone: r.suppressEveryone,
  };
}

export async function listNotificationSettings(userId: string): Promise<NotificationSettingDTO[]> {
  const rows = await prisma.notificationSetting.findMany({ where: { userId } });
  return rows.map(toNotif);
}

export async function putNotificationSetting(userId: string, input: z.output<typeof notificationSettingSchema>) {
  const valid = cache.guild(input.targetId) ? cache.isMember(input.targetId, userId) : cache.canView(input.targetId, userId);
  if (!valid) throw notFound("unknown_target");
  const data = {
    ...(input.level !== undefined ? { level: input.level } : {}),
    ...(input.muted !== undefined ? { muted: input.muted } : {}),
    ...(input.muteUntil !== undefined ? { muteUntil: input.muteUntil ? new Date(input.muteUntil) : null } : {}),
    ...(input.suppressEveryone !== undefined ? { suppressEveryone: input.suppressEveryone } : {}),
  };
  await prisma.notificationSetting.upsert({
    where: { userId_targetId: { userId, targetId: input.targetId } },
    create: { userId, targetId: input.targetId, ...data },
    update: data,
  });
  const settings = await listNotificationSettings(userId);
  toUser(userId, "NOTIFICATION_SETTINGS_UPDATE", { settings });
  return settings;
}

// ── sessions ─────────────────────────────────────────────────────────────────
export async function listSessions(userId: string, currentSid: string): Promise<SessionDTO[]> {
  const rows = await prisma.session.findMany({ where: { userId, expiresAt: { gt: new Date() } }, orderBy: { lastUsedAt: "desc" } });
  return rows.map((s) => ({
    id: s.id,
    device: s.device,
    platform: (s.platform as SessionDTO["platform"]) ?? null,
    ip: s.ip,
    createdAt: s.createdAt.toISOString(),
    lastUsedAt: s.lastUsedAt.toISOString(),
    current: s.id === currentSid,
  }));
}

export async function revokeSession(userId: string, sid: string, reason = "signed_out") {
  const r = await prisma.session.deleteMany({ where: { id: sid, userId } });
  forgetSession(sid);
  disconnectSession(sid, reason);
  closeSessionStreams(sid);
  return r.count > 0;
}

export async function revokeOtherSessions(userId: string, keepSid: string) {
  const rows = await prisma.session.findMany({ where: { userId, NOT: { id: keepSid } }, select: { id: true } });
  for (const r of rows) await revokeSession(userId, r.id, "signed_out_elsewhere");
}
