// Guilds ("servers"): lifecycle, membership, roles (with hierarchy and
// no-escalation rules), moderation (kick/ban/timeout), custom emoji.
import {
  ALL_PERMISSIONS,
  DEFAULT_EVERYONE_PERMISSIONS,
  MessageType,
  Permission,
  hasPerm,
  parsePerms,
  ulid,
  type GuildCreatePayload,
  type GuildDTO,
} from "@nova/shared";
import type { z } from "zod";
import type { guildCreateSchema, guildUpdateSchema, memberUpdateSchema, roleCreateSchema, roleUpdateSchema } from "@nova/shared";
import { prisma } from "../db";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { deleteStored } from "../lib/files";
import { cache } from "../state/cache";
import { presence } from "../state/presence";
import { voice } from "../state/voice";
import { joinGuildRoom, leaveGuildRoom, toGuild, toUser } from "../gateway/io";
import { channelInclude, memberInclude, toChannel, toEmoji, toGuildBase, toMember, toRole, toUser as toUserDto, userSelect } from "./serialize";
import { withVisibilityDiff } from "./visibility";
import { audit } from "./audit";
import { createMessage, purgeUserMessages } from "./messages";

type Tmpl = { cats: { name: string; channels: { name: string; type: "text" | "voice" }[] }[] };

const TEMPLATES: Record<string, Record<"ru" | "en", Tmpl>> = {
  default: {
    ru: { cats: [{ name: "Текстовые каналы", channels: [{ name: "общий", type: "text" }] }, { name: "Голосовые каналы", channels: [{ name: "Общий", type: "voice" }] }] },
    en: { cats: [{ name: "Text Channels", channels: [{ name: "general", type: "text" }] }, { name: "Voice Channels", channels: [{ name: "General", type: "voice" }] }] },
  },
  gaming: {
    ru: {
      cats: [
        { name: "Информация", channels: [{ name: "правила", type: "text" }, { name: "новости", type: "text" }] },
        { name: "Чат", channels: [{ name: "общий", type: "text" }, { name: "поиск-тиммейтов", type: "text" }, { name: "клипы", type: "text" }] },
        { name: "Голосовые", channels: [{ name: "Лобби", type: "voice" }, { name: "Игра 1", type: "voice" }, { name: "Игра 2", type: "voice" }] },
      ],
    },
    en: {
      cats: [
        { name: "Info", channels: [{ name: "rules", type: "text" }, { name: "news", type: "text" }] },
        { name: "Chat", channels: [{ name: "general", type: "text" }, { name: "lfg", type: "text" }, { name: "clips", type: "text" }] },
        { name: "Voice", channels: [{ name: "Lobby", type: "voice" }, { name: "Game 1", type: "voice" }, { name: "Game 2", type: "voice" }] },
      ],
    },
  },
  friends: {
    ru: { cats: [{ name: "Болтаем", channels: [{ name: "общий", type: "text" }, { name: "мемы", type: "text" }, { name: "фото", type: "text" }] }, { name: "Голосовые", channels: [{ name: "Тусовка", type: "voice" }, { name: "Кино", type: "voice" }] }] },
    en: { cats: [{ name: "Hangout", channels: [{ name: "general", type: "text" }, { name: "memes", type: "text" }, { name: "photos", type: "text" }] }, { name: "Voice", channels: [{ name: "Chill", type: "voice" }, { name: "Movie night", type: "voice" }] }] },
  },
  study: {
    ru: { cats: [{ name: "Учёба", channels: [{ name: "общий", type: "text" }, { name: "домашка", type: "text" }, { name: "материалы", type: "text" }] }, { name: "Голосовые", channels: [{ name: "Учебная", type: "voice" }, { name: "Перерыв", type: "voice" }] }] },
    en: { cats: [{ name: "Study", channels: [{ name: "general", type: "text" }, { name: "homework", type: "text" }, { name: "resources", type: "text" }] }, { name: "Voice", channels: [{ name: "Study room", type: "voice" }, { name: "Break", type: "voice" }] }] },
  },
  empty: {
    ru: { cats: [{ name: "Каналы", channels: [{ name: "общий", type: "text" }] }] },
    en: { cats: [{ name: "Channels", channels: [{ name: "general", type: "text" }] }] },
  },
};

// ── payloads ─────────────────────────────────────────────────────────────────
export async function buildGuild(guildId: string, forUserId: string): Promise<GuildDTO | null> {
  const g = await prisma.guild.findUnique({
    where: { id: guildId },
    include: {
      roles: { orderBy: { position: "asc" } },
      channels: { where: { NOT: { type: "thread", archived: true } }, include: channelInclude },
      members: { include: memberInclude },
      emojis: { orderBy: { name: "asc" } },
    },
  });
  if (!g) return null;
  return {
    ...toGuildBase(g),
    roles: g.roles.map(toRole),
    channels: g.channels.filter((c) => cache.canView(c.id, forUserId)).map(toChannel),
    members: g.members.map(toMember),
    emojis: g.emojis.map(toEmoji),
  };
}

export async function buildGuildCreate(guildId: string, forUserId: string): Promise<GuildCreatePayload | null> {
  const guild = await buildGuild(guildId, forUserId);
  if (!guild) return null;
  const users = await prisma.user.findMany({ where: { id: { in: guild.members.map((m) => m.userId) } }, select: userSelect });
  return {
    ...guild,
    users: users.map(toUserDto),
    presences: guild.members.map((m) => presence.get(m.userId)).filter((p) => p.status !== "offline"),
    voiceStates: voice.statesForGuild(guildId),
  };
}

function requireMember(guildId: string, userId: string) {
  if (!cache.isMember(guildId, userId)) throw notFound("unknown_guild");
}

function requireGuildPerm(guildId: string, userId: string, perm: bigint) {
  requireMember(guildId, userId);
  if (!cache.hasGuildPerm(guildId, userId, perm)) throw forbidden("missing_permissions");
}

// ── lifecycle ────────────────────────────────────────────────────────────────
export async function createGuild(ownerId: string, input: z.output<typeof guildCreateSchema>) {
  const owned = await prisma.guild.count({ where: { ownerId } });
  if (owned >= 100) throw badRequest("too_many_guilds");
  const guildId = ulid();
  const tmpl = TEMPLATES[input.template]?.[input.locale] ?? TEMPLATES.default.ru;
  const channels: { id: string; type: string; name: string; parentId: string | null; position: number; bitrate?: number }[] = [];
  let systemChannelId: string | null = null;
  tmpl.cats.forEach((cat, ci) => {
    const catId = ulid();
    channels.push({ id: catId, type: "category", name: cat.name, parentId: null, position: ci });
    cat.channels.forEach((c, i) => {
      const id = ulid();
      if (!systemChannelId && c.type === "text") systemChannelId = id;
      channels.push({ id, type: c.type, name: c.name, parentId: catId, position: i, ...(c.type === "voice" ? { bitrate: 96000 } : {}) });
    });
  });

  await prisma.$transaction([
    prisma.guild.create({ data: { id: guildId, name: input.name, icon: input.icon ?? null, ownerId, systemChannelId } }),
    prisma.role.create({ data: { id: guildId, guildId, name: "@everyone", permissions: DEFAULT_EVERYONE_PERMISSIONS.toString(), position: 0 } }),
    prisma.channel.createMany({ data: channels.map((c) => ({ ...c, guildId })) }),
    prisma.member.create({ data: { guildId, userId: ownerId } }),
  ]);
  await cache.reloadGuild(guildId);
  joinGuildRoom(ownerId, guildId);
  const payload = await buildGuildCreate(guildId, ownerId);
  if (payload) toUser(ownerId, "GUILD_CREATE", payload);
  return payload!;
}

export async function updateGuild(actorId: string, guildId: string, input: z.output<typeof guildUpdateSchema>) {
  requireGuildPerm(guildId, actorId, Permission.MANAGE_GUILD);
  if (input.systemChannelId) {
    const c = cache.channel(input.systemChannelId);
    if (!c || c.guildId !== guildId || c.type !== "text") throw badRequest("invalid_channel");
  }
  const g = await prisma.guild.update({ where: { id: guildId }, data: input });
  toGuild(guildId, "GUILD_UPDATE", toGuildBase(g));
  await audit(guildId, actorId, "guild_update", guildId, input as Record<string, unknown>);
  return toGuildBase(g);
}

async function collectAttachmentPaths(channelIds: string[]) {
  const rows = await prisma.attachment.findMany({ where: { message: { channelId: { in: channelIds } } }, select: { path: true } });
  return rows.map((r) => r.path);
}

export async function deleteGuild(actorId: string, guildId: string) {
  const g = cache.guild(guildId);
  if (!g) throw notFound("unknown_guild");
  if (g.ownerId !== actorId) throw forbidden("owner_only");
  const channelIds = [...g.channels.keys()];
  const members = [...g.members.keys()];
  const paths = await collectAttachmentPaths(channelIds);
  const emojis = await prisma.emoji.findMany({ where: { guildId }, select: { path: true } });
  for (const cid of channelIds) await voice.closeChannel(cid);
  await prisma.guild.delete({ where: { id: guildId } });
  await prisma.readState.deleteMany({ where: { channelId: { in: channelIds } } });
  await prisma.notificationSetting.deleteMany({ where: { targetId: { in: [guildId, ...channelIds] } } });
  toGuild(guildId, "GUILD_DELETE", { id: guildId });
  for (const uid of members) leaveGuildRoom(uid, guildId);
  cache.dropGuild(guildId);
  void (async () => {
    for (const p of [...paths, ...emojis.map((e) => e.path.replace(/^\/files\//, ""))]) await deleteStored(decodeURIComponent(p));
  })();
}

export async function transferOwnership(actorId: string, guildId: string, newOwnerId: string) {
  const g = cache.guild(guildId);
  if (!g) throw notFound("unknown_guild");
  if (g.ownerId !== actorId) throw forbidden("owner_only");
  if (!g.members.has(newOwnerId)) throw badRequest("not_a_member");
  await withVisibilityDiff(guildId, async () => {
    await prisma.guild.update({ where: { id: guildId }, data: { ownerId: newOwnerId } });
    await cache.reloadGuild(guildId);
  });
  const row = await prisma.guild.findUnique({ where: { id: guildId } });
  if (row) toGuild(guildId, "GUILD_UPDATE", toGuildBase(row));
}

// ── membership ───────────────────────────────────────────────────────────────
export async function addMember(guildId: string, userId: string) {
  if (cache.isMember(guildId, userId)) return false;
  const ban = await prisma.ban.findUnique({ where: { guildId_userId: { guildId, userId } } });
  if (ban) throw forbidden("banned");
  const count = cache.guild(guildId)?.members.size ?? 0;
  if (count >= 25_000) throw badRequest("guild_full");
  const m = await prisma.member.create({ data: { guildId, userId }, include: { ...memberInclude, user: { select: userSelect } } });
  cache.addMember(guildId, userId);
  toGuild(guildId, "GUILD_MEMBER_ADD", { ...toMember(m), user: toUserDto(m.user) });
  joinGuildRoom(userId, guildId);
  const payload = await buildGuildCreate(guildId, userId);
  if (payload) toUser(userId, "GUILD_CREATE", payload);
  const g = await prisma.guild.findUnique({ where: { id: guildId }, select: { systemChannelId: true } });
  if (g?.systemChannelId && cache.channel(g.systemChannelId)) {
    await createMessage(userId, g.systemChannelId, { content: "" }, { type: MessageType.GUILD_MEMBER_JOIN }).catch(() => {});
  }
  return true;
}

async function removeMember(guildId: string, userId: string) {
  await prisma.member.deleteMany({ where: { guildId, userId } });
  cache.removeMember(guildId, userId);
  const vs = voice.get(userId);
  if (vs?.guildId === guildId) await voice.kick(userId);
  toGuild(guildId, "GUILD_MEMBER_REMOVE", { guildId, userId });
  toUser(userId, "GUILD_DELETE", { id: guildId });
  leaveGuildRoom(userId, guildId);
}

export async function leaveGuild(userId: string, guildId: string) {
  const g = cache.guild(guildId);
  if (!g || !g.members.has(userId)) throw notFound("unknown_guild");
  if (g.ownerId === userId) throw badRequest("owner_cannot_leave");
  await removeMember(guildId, userId);
}

export async function kickMember(actorId: string, guildId: string, targetId: string, reason?: string) {
  requireGuildPerm(guildId, actorId, Permission.KICK_MEMBERS);
  if (!cache.isMember(guildId, targetId)) throw notFound("unknown_member");
  if (!cache.outranks(guildId, actorId, targetId)) throw forbidden("hierarchy");
  await removeMember(guildId, targetId);
  await audit(guildId, actorId, "member_kick", targetId, null, reason);
}

export async function banMember(actorId: string, guildId: string, targetId: string, reason?: string, deleteMessageSeconds = 0) {
  requireGuildPerm(guildId, actorId, Permission.BAN_MEMBERS);
  if (actorId === targetId) throw badRequest("cannot_ban_self");
  if (cache.isMember(guildId, targetId) && !cache.outranks(guildId, actorId, targetId)) throw forbidden("hierarchy");
  if (cache.guild(guildId)?.ownerId === targetId) throw forbidden("hierarchy");
  const exists = await prisma.user.count({ where: { id: targetId } });
  if (!exists) throw notFound("unknown_user");
  await prisma.ban.upsert({ where: { guildId_userId: { guildId, userId: targetId } }, create: { guildId, userId: targetId, reason: reason ?? null }, update: { reason: reason ?? null } });
  if (cache.isMember(guildId, targetId)) await removeMember(guildId, targetId);
  await purgeUserMessages(guildId, targetId, deleteMessageSeconds * 1000);
  await prisma.invite.deleteMany({ where: { guildId, inviterId: targetId } });
  await audit(guildId, actorId, "member_ban", targetId, { deleteMessageSeconds }, reason);
}

export async function unbanMember(actorId: string, guildId: string, targetId: string) {
  requireGuildPerm(guildId, actorId, Permission.BAN_MEMBERS);
  const r = await prisma.ban.deleteMany({ where: { guildId, userId: targetId } });
  if (!r.count) throw notFound("unknown_ban");
  await audit(guildId, actorId, "member_unban", targetId);
}

export async function listBans(actorId: string, guildId: string) {
  requireGuildPerm(guildId, actorId, Permission.BAN_MEMBERS);
  const bans = await prisma.ban.findMany({ where: { guildId }, orderBy: { createdAt: "desc" } });
  const users = await prisma.user.findMany({ where: { id: { in: bans.map((b) => b.userId) } }, select: userSelect });
  const byId = new Map(users.map((u) => [u.id, toUserDto(u)]));
  return bans.filter((b) => byId.has(b.userId)).map((b) => ({ user: byId.get(b.userId)!, reason: b.reason, createdAt: b.createdAt.toISOString() }));
}

async function emitMember(guildId: string, userId: string) {
  const m = await prisma.member.findUnique({ where: { guildId_userId: { guildId, userId } }, include: { ...memberInclude, user: { select: userSelect } } });
  if (!m) return null;
  const dto = { ...toMember(m), user: toUserDto(m.user) };
  toGuild(guildId, "GUILD_MEMBER_UPDATE", dto);
  return dto;
}

export async function updateMember(actorId: string, guildId: string, targetId: string, input: z.output<typeof memberUpdateSchema>) {
  requireMember(guildId, actorId);
  const g = cache.guild(guildId)!;
  const target = g.members.get(targetId);
  if (!target) throw notFound("unknown_member");
  const self = actorId === targetId;
  const data: { nick?: string | null; timeoutUntil?: Date | null } = {};

  if (input.nick !== undefined) {
    const perm = self ? Permission.CHANGE_NICKNAME : Permission.MANAGE_NICKNAMES;
    if (!cache.hasGuildPerm(guildId, actorId, perm) && !(self && cache.hasGuildPerm(guildId, actorId, Permission.MANAGE_NICKNAMES))) throw forbidden("missing_permissions");
    if (!self && !cache.outranks(guildId, actorId, targetId)) throw forbidden("hierarchy");
    data.nick = input.nick || null;
  }

  if (input.timeoutUntil !== undefined) {
    if (!cache.hasGuildPerm(guildId, actorId, Permission.MODERATE_MEMBERS)) throw forbidden("missing_permissions");
    if (self || !cache.outranks(guildId, actorId, targetId)) throw forbidden("hierarchy");
    if (hasPerm(cache.basePerms(guildId, targetId), Permission.ADMINISTRATOR)) throw forbidden("cannot_timeout_admin");
    const until = input.timeoutUntil ? new Date(input.timeoutUntil) : null;
    if (until && until.getTime() > Date.now() + 28 * 86_400_000) throw badRequest("timeout_too_long");
    data.timeoutUntil = until && until.getTime() > Date.now() ? until : null;
  }

  let roleChange: { add: string[]; remove: string[] } | null = null;
  if (input.roles) {
    if (!cache.hasGuildPerm(guildId, actorId, Permission.MANAGE_ROLES)) throw forbidden("missing_permissions");
    if (!self && !cache.outranks(guildId, actorId, targetId)) throw forbidden("hierarchy");
    const top = cache.topRolePosition(guildId, actorId);
    const wanted = [...new Set(input.roles)].filter((r) => r !== guildId);
    for (const r of wanted) if (!g.roles.has(r)) throw badRequest("unknown_role");
    const add = wanted.filter((r) => !target.roles.includes(r));
    const remove = target.roles.filter((r) => !wanted.includes(r));
    for (const r of [...add, ...remove]) if ((g.roles.get(r)?.position ?? 0) >= top) throw forbidden("hierarchy");
    roleChange = { add, remove };
  }

  await withVisibilityDiff(guildId, async () => {
    if (Object.keys(data).length) await prisma.member.update({ where: { guildId_userId: { guildId, userId: targetId } }, data });
    if (roleChange) {
      if (roleChange.remove.length) await prisma.memberRole.deleteMany({ where: { guildId, userId: targetId, roleId: { in: roleChange.remove } } });
      for (const roleId of roleChange.add) await prisma.memberRole.create({ data: { guildId, userId: targetId, roleId } });
      cache.setMember(guildId, targetId, { roles: [...target.roles.filter((r) => !roleChange!.remove.includes(r)), ...roleChange.add] });
    }
    if (data.timeoutUntil !== undefined) cache.setMember(guildId, targetId, { timeoutUntil: data.timeoutUntil?.getTime() ?? null });
  });

  if (data.timeoutUntil) await voice.kick(targetId, guildId);
  const dto = await emitMember(guildId, targetId);
  if (roleChange && (roleChange.add.length || roleChange.remove.length)) await audit(guildId, actorId, "member_role_update", targetId, roleChange, input.reason);
  if (data.timeoutUntil !== undefined) await audit(guildId, actorId, "member_timeout", targetId, { until: data.timeoutUntil?.toISOString() ?? null }, input.reason);
  if (data.nick !== undefined && !self) await audit(guildId, actorId, "member_update", targetId, { nick: data.nick });
  return dto;
}

// ── roles ────────────────────────────────────────────────────────────────────
/** Non-admins can't grant permissions they don't hold themselves. */
function assertNoEscalation(guildId: string, actorId: string, requested: bigint) {
  const mine = cache.basePerms(guildId, actorId);
  if (mine === ALL_PERMISSIONS) return;
  if ((requested & ~mine) !== 0n) throw forbidden("permission_escalation");
}

export async function createRole(actorId: string, guildId: string, input: z.output<typeof roleCreateSchema>) {
  requireGuildPerm(guildId, actorId, Permission.MANAGE_ROLES);
  const count = cache.guild(guildId)!.roles.size;
  if (count >= 250) throw badRequest("too_many_roles");
  const perms = parsePerms(input.permissions ?? "0");
  assertNoEscalation(guildId, actorId, perms);
  const id = ulid();
  await prisma.$transaction([
    prisma.role.updateMany({ where: { guildId, position: { gte: 1 } }, data: { position: { increment: 1 } } }),
    prisma.role.create({ data: { id, guildId, name: input.name, color: input.color, permissions: perms.toString(), hoist: input.hoist, mentionable: input.mentionable, position: 1 } }),
  ]);
  await cache.reloadGuild(guildId);
  const roles = await prisma.role.findMany({ where: { guildId } });
  const created = roles.find((r) => r.id === id)!;
  toGuild(guildId, "GUILD_ROLE_CREATE", toRole(created));
  toGuild(guildId, "GUILD_ROLE_POSITIONS_UPDATE", { guildId, positions: roles.map((r) => ({ id: r.id, position: r.position })) });
  await audit(guildId, actorId, "role_create", id, { name: input.name });
  return toRole(created);
}

function assertRoleEditable(guildId: string, actorId: string, roleId: string) {
  const g = cache.guild(guildId)!;
  const role = g.roles.get(roleId);
  if (!role) throw notFound("unknown_role");
  if (g.ownerId !== actorId && role.position >= cache.topRolePosition(guildId, actorId) && roleId !== guildId) throw forbidden("hierarchy");
  return role;
}

export async function updateRole(actorId: string, guildId: string, roleId: string, input: z.output<typeof roleUpdateSchema>) {
  requireGuildPerm(guildId, actorId, Permission.MANAGE_ROLES);
  assertRoleEditable(guildId, actorId, roleId);
  const data: Record<string, unknown> = {};
  if (roleId === guildId) {
    if (input.permissions !== undefined) data.permissions = input.permissions;
  } else Object.assign(data, input);
  if (data.permissions !== undefined) {
    const next = parsePerms(data.permissions as string);
    const prev = cache.guild(guildId)!.roles.get(roleId)!.permissions;
    assertNoEscalation(guildId, actorId, next & ~prev);
    data.permissions = next.toString();
  }
  const role = await withVisibilityDiff(guildId, async () => {
    const r = await prisma.role.update({ where: { id: roleId }, data });
    cache.setRole(guildId, r);
    return r;
  });
  toGuild(guildId, "GUILD_ROLE_UPDATE", toRole(role));
  await audit(guildId, actorId, "role_update", roleId, data);
  return toRole(role);
}

export async function deleteRole(actorId: string, guildId: string, roleId: string) {
  requireGuildPerm(guildId, actorId, Permission.MANAGE_ROLES);
  if (roleId === guildId) throw badRequest("cannot_delete_everyone");
  assertRoleEditable(guildId, actorId, roleId);
  await withVisibilityDiff(guildId, async () => {
    await prisma.role.delete({ where: { id: roleId } });
    await prisma.permissionOverwrite.deleteMany({ where: { targetId: roleId } });
    cache.removeRole(guildId, roleId);
  });
  toGuild(guildId, "GUILD_ROLE_DELETE", { guildId, roleId });
  await audit(guildId, actorId, "role_delete", roleId);
}

export async function setRolePositions(actorId: string, guildId: string, positions: { id: string; position: number }[]) {
  requireGuildPerm(guildId, actorId, Permission.MANAGE_ROLES);
  const g = cache.guild(guildId)!;
  const top = cache.topRolePosition(guildId, actorId);
  const owner = g.ownerId === actorId;
  for (const p of positions) {
    const r = g.roles.get(p.id);
    if (!r || p.id === guildId) throw badRequest("unknown_role");
    if (!owner && (r.position >= top || p.position >= top)) throw forbidden("hierarchy");
  }
  await prisma.$transaction(positions.map((p) => prisma.role.update({ where: { id: p.id }, data: { position: p.position } })));
  // Normalize to 1..n so positions stay dense and unique.
  const all = await prisma.role.findMany({ where: { guildId, NOT: { id: guildId } }, orderBy: [{ position: "asc" }, { id: "asc" }] });
  await prisma.$transaction(all.map((r, i) => prisma.role.update({ where: { id: r.id }, data: { position: i + 1 } })));
  await withVisibilityDiff(guildId, () => cache.reloadGuild(guildId));
  const roles = await prisma.role.findMany({ where: { guildId } });
  toGuild(guildId, "GUILD_ROLE_POSITIONS_UPDATE", { guildId, positions: roles.map((r) => ({ id: r.id, position: r.position })) });
}

// ── emoji ────────────────────────────────────────────────────────────────────
async function emitEmojis(guildId: string) {
  const emojis = await prisma.emoji.findMany({ where: { guildId }, orderBy: { name: "asc" } });
  toGuild(guildId, "GUILD_EMOJIS_UPDATE", { guildId, emojis: emojis.map(toEmoji) });
}

export async function createEmoji(actorId: string, guildId: string, name: string, path: string, animated: boolean) {
  requireGuildPerm(guildId, actorId, Permission.MANAGE_EMOJIS);
  if ((await prisma.emoji.count({ where: { guildId } })) >= 500) throw badRequest("too_many_emojis");
  if (await prisma.emoji.findUnique({ where: { guildId_name: { guildId, name } } })) throw conflict("emoji_name_taken");
  const e = await prisma.emoji.create({ data: { id: ulid(), guildId, name, path, animated, creatorId: actorId } });
  await emitEmojis(guildId);
  await audit(guildId, actorId, "emoji_create", e.id, { name });
  return toEmoji(e);
}

export async function renameEmoji(actorId: string, guildId: string, emojiId: string, name: string) {
  requireGuildPerm(guildId, actorId, Permission.MANAGE_EMOJIS);
  const e = await prisma.emoji.findUnique({ where: { id: emojiId } });
  if (!e || e.guildId !== guildId) throw notFound("unknown_emoji");
  if (await prisma.emoji.findFirst({ where: { guildId, name, NOT: { id: emojiId } } })) throw conflict("emoji_name_taken");
  await prisma.emoji.update({ where: { id: emojiId }, data: { name } });
  await emitEmojis(guildId);
}

export async function deleteEmoji(actorId: string, guildId: string, emojiId: string) {
  requireGuildPerm(guildId, actorId, Permission.MANAGE_EMOJIS);
  const e = await prisma.emoji.findUnique({ where: { id: emojiId } });
  if (!e || e.guildId !== guildId) throw notFound("unknown_emoji");
  await prisma.emoji.delete({ where: { id: emojiId } });
  await emitEmojis(guildId);
  await audit(guildId, actorId, "emoji_delete", emojiId, { name: e.name });
}

export { requireGuildPerm, requireMember };
