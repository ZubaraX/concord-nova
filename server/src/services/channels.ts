// Channels: guild channels (with permission overwrites and visibility
// diffing), ordering, DMs, group DMs and threads.
import {
  LIMITS,
  MessageType,
  Permission,
  RelationshipType,
  hasPerm,
  parsePerms,
  ulid,
  type ChannelDTO,
} from "@nova/shared";
import type { z } from "zod";
import type { channelCreateSchema, channelUpdateSchema, overwriteSchema } from "@nova/shared";
import { prisma } from "../db";
import { badRequest, forbidden, notFound } from "../lib/errors";
import { deleteStored } from "../lib/files";
import { cache } from "../state/cache";
import { voice } from "../state/voice";
import { toChannel, toGuild, toUser, toUsers } from "../gateway/io";
import { channelInclude, loadMessage, toChannel as toDto, toGuildBase } from "./serialize";
import { withVisibilityDiff } from "./visibility";
import { audit } from "./audit";
import { createMessage } from "./messages";

type OverwriteInput = z.output<typeof overwriteSchema>;

async function loadDto(channelId: string): Promise<ChannelDTO | null> {
  const row = await prisma.channel.findUnique({ where: { id: channelId }, include: channelInclude });
  return row ? toDto(row) : null;
}

function validateOverwrites(guildId: string, actorId: string, list: OverwriteInput[]) {
  const g = cache.guild(guildId)!;
  const mine = cache.basePerms(guildId, actorId);
  const admin = hasPerm(mine, Permission.ADMINISTRATOR);
  for (const o of list) {
    if (o.type === "role" && !g.roles.has(o.id)) throw badRequest("unknown_role");
    if (o.type === "member" && !g.members.has(o.id)) throw badRequest("unknown_member");
    const touched = parsePerms(o.allow) | parsePerms(o.deny);
    if (!admin && (touched & ~mine) !== 0n) throw forbidden("permission_escalation");
  }
}

export async function createChannel(actorId: string, guildId: string, input: z.output<typeof channelCreateSchema>): Promise<ChannelDTO> {
  if (!cache.isMember(guildId, actorId)) throw notFound("unknown_guild");
  if (!cache.hasGuildPerm(guildId, actorId, Permission.MANAGE_CHANNELS)) throw forbidden("missing_permissions");
  const g = cache.guild(guildId)!;
  if (g.channels.size >= 500) throw badRequest("too_many_channels");
  let parentId = input.parentId ?? null;
  if (input.type === "category") parentId = null;
  if (parentId) {
    const p = g.channels.get(parentId);
    if (!p || p.type !== "category") throw badRequest("invalid_parent");
  }
  let overwrites: OverwriteInput[] = input.overwrites ?? [];
  if (input.overwrites) validateOverwrites(guildId, actorId, overwrites);
  else if (parentId) {
    // New channels start synced with their category's permissions.
    overwrites = g.channels.get(parentId)!.overwrites.map((o) => ({ id: o.id, type: o.type, allow: String(o.allow), deny: String(o.deny) }));
  }
  const siblings = [...g.channels.values()].filter((c) => (c.parentId ?? null) === parentId && c.type !== "thread");
  const maxPos = await prisma.channel.aggregate({ where: { id: { in: siblings.map((s) => s.id) } }, _max: { position: true } });
  const id = ulid();
  const name = input.type === "text" || input.type === "announcement" ? input.name.toLowerCase().replace(/\s+/g, "-") : input.name;
  await prisma.channel.create({
    data: {
      id,
      guildId,
      type: input.type,
      name,
      parentId,
      topic: input.topic ?? null,
      nsfw: input.nsfw ?? false,
      bitrate: input.bitrate ?? 96_000,
      userLimit: input.userLimit ?? 0,
      position: (maxPos._max.position ?? -1) + 1,
      overwrites: { create: overwrites.map((o) => ({ targetId: o.id, type: o.type, allow: o.allow, deny: o.deny })) },
    },
  });
  const row = await prisma.channel.findUnique({ where: { id }, include: channelInclude });
  cache.setChannel(row!);
  const dto = toDto(row!);
  toChannel(id, "CHANNEL_CREATE", dto);
  await audit(guildId, actorId, "channel_create", id, { name, type: input.type });
  return dto;
}

export async function updateChannel(actorId: string, channelId: string, input: z.output<typeof channelUpdateSchema>): Promise<ChannelDTO> {
  const priv = cache.privates.get(channelId);
  if (priv) {
    if (priv.type !== "group_dm" || !priv.recipients.has(actorId)) throw forbidden("missing_permissions");
    const data: { name?: string; icon?: string | null } = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.icon !== undefined) data.icon = input.icon;
    await prisma.channel.update({ where: { id: channelId }, data });
    const dto = (await loadDto(channelId))!;
    toChannel(channelId, "CHANNEL_UPDATE", dto);
    return dto;
  }

  const c = cache.channel(channelId);
  if (!c) throw notFound("unknown_channel");
  const bits = cache.channelPerms(channelId, actorId);
  if (!hasPerm(bits, Permission.VIEW_CHANNEL)) throw notFound("unknown_channel");

  if (c.type === "thread") {
    const row = await prisma.channel.findUnique({ where: { id: channelId }, select: { ownerId: true } });
    const mod = hasPerm(bits, Permission.MANAGE_MESSAGES);
    if (!mod && row?.ownerId !== actorId) throw forbidden("missing_permissions");
    if (input.locked !== undefined && !mod) throw forbidden("missing_permissions");
    const data: { name?: string; archived?: boolean; locked?: boolean; slowmode?: number } = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.archived !== undefined) data.archived = input.archived;
    if (input.locked !== undefined) data.locked = input.locked;
    if (input.slowmode !== undefined && mod) data.slowmode = input.slowmode;
    await prisma.channel.update({ where: { id: channelId }, data });
    const full = await prisma.channel.findUnique({ where: { id: channelId }, include: channelInclude });
    cache.setChannel(full!);
    const dto = toDto(full!);
    toChannel(channelId, "CHANNEL_UPDATE", dto);
    return dto;
  }

  if (!hasPerm(bits, Permission.MANAGE_CHANNELS)) throw forbidden("missing_permissions");
  const guildId = c.guildId;
  const data: Record<string, unknown> = {};
  for (const k of ["name", "topic", "nsfw", "slowmode", "bitrate", "userLimit"] as const) if (input[k] !== undefined) data[k] = input[k];
  if (typeof data.name === "string" && (c.type === "text" || c.type === "announcement")) data.name = (data.name as string).toLowerCase().replace(/\s+/g, "-");
  if (input.parentId !== undefined) {
    if (c.type === "category" && input.parentId) throw badRequest("invalid_parent");
    if (input.parentId) {
      const p = cache.channel(input.parentId);
      if (!p || p.guildId !== guildId || p.type !== "category") throw badRequest("invalid_parent");
    }
    data.parentId = input.parentId;
  }
  if (input.overwrites) {
    if (!hasPerm(bits, Permission.MANAGE_ROLES)) throw forbidden("missing_permissions");
    validateOverwrites(guildId, actorId, input.overwrites);
  }

  // Viewers before the change still need to hear about a now-hidden channel.
  const dto = await withVisibilityDiff(guildId, async () => {
    await prisma.$transaction(async (tx) => {
      await tx.channel.update({ where: { id: channelId }, data });
      if (input.overwrites) {
        await tx.permissionOverwrite.deleteMany({ where: { channelId } });
        if (input.overwrites.length) {
          await tx.permissionOverwrite.createMany({ data: input.overwrites.map((o) => ({ channelId, targetId: o.id, type: o.type, allow: o.allow, deny: o.deny })) });
        }
      }
    });
    const full = await prisma.channel.findUnique({ where: { id: channelId }, include: channelInclude });
    cache.setChannel(full!);
    return toDto(full!);
  });
  toChannel(channelId, "CHANNEL_UPDATE", dto);
  await audit(guildId, actorId, input.overwrites ? "overwrite_update" : "channel_update", channelId, { ...data, ...(input.overwrites ? { overwrites: input.overwrites.length } : {}) });
  return dto;
}

async function purgeChannelFiles(channelIds: string[]) {
  const rows = await prisma.attachment.findMany({ where: { message: { channelId: { in: channelIds } } }, select: { path: true } });
  return rows.map((r) => r.path);
}

export async function deleteChannel(actorId: string, channelId: string) {
  const priv = cache.privates.get(channelId);
  if (priv) {
    if (!priv.recipients.has(actorId)) throw notFound("unknown_channel");
    if (priv.type === "dm") {
      await prisma.channelRecipient.update({ where: { channelId_userId: { channelId, userId: actorId } }, data: { closed: true } });
      toUser(actorId, "CHANNEL_DELETE", { id: channelId, guildId: null });
      return;
    }
    await removeGroupRecipient(actorId, channelId, actorId);
    return;
  }

  const c = cache.channel(channelId);
  if (!c) throw notFound("unknown_channel");
  const bits = cache.channelPerms(channelId, actorId);
  if (!hasPerm(bits, Permission.VIEW_CHANNEL)) throw notFound("unknown_channel");
  if (c.type === "thread") {
    if (!hasPerm(bits, Permission.MANAGE_MESSAGES)) {
      const row = await prisma.channel.findUnique({ where: { id: channelId }, select: { ownerId: true } });
      if (row?.ownerId !== actorId) throw forbidden("missing_permissions");
    }
  } else if (!hasPerm(bits, Permission.MANAGE_CHANNELS)) throw forbidden("missing_permissions");

  const guildId = c.guildId;
  const g = cache.guild(guildId)!;
  const threads = [...g.channels.values()].filter((x) => x.type === "thread" && x.parentId === channelId).map((x) => x.id);
  const ids = [channelId, ...threads];
  const notify = new Map(ids.map((id) => [id, cache.viewers(id)]));
  const files = await purgeChannelFiles(ids);

  await voice.closeChannel(channelId);
  if (c.type === "category") {
    const children = [...g.channels.values()].filter((x) => x.parentId === channelId && x.type !== "thread");
    await prisma.channel.updateMany({ where: { parentId: channelId, type: { not: "thread" } }, data: { parentId: null } });
    for (const ch of children) {
      const full = await prisma.channel.findUnique({ where: { id: ch.id }, include: channelInclude });
      if (full) {
        cache.setChannel(full);
        toChannel(ch.id, "CHANNEL_UPDATE", toDto(full));
      }
    }
  }
  if (c.type === "thread") await prisma.message.updateMany({ where: { threadId: channelId }, data: { threadId: null } });
  await prisma.channel.deleteMany({ where: { id: { in: ids } } });
  await prisma.readState.deleteMany({ where: { channelId: { in: ids } } });
  await prisma.notificationSetting.deleteMany({ where: { targetId: { in: ids } } });
  for (const id of ids) cache.removeChannel(id);
  for (const [id, users] of notify) toUsers(users, "CHANNEL_DELETE", { id, guildId });

  const guild = await prisma.guild.findUnique({ where: { id: guildId } });
  if (guild?.systemChannelId && ids.includes(guild.systemChannelId)) {
    const updated = await prisma.guild.update({ where: { id: guildId }, data: { systemChannelId: null } });
    toGuild(guildId, "GUILD_UPDATE", toGuildBase(updated));
  }
  if (c.type !== "thread") await audit(guildId, actorId, "channel_delete", channelId, { type: c.type });
  void (async () => {
    for (const p of files) await deleteStored(p);
  })();
}

export async function setChannelPositions(actorId: string, guildId: string, items: { id: string; position: number; parentId?: string | null }[]) {
  if (!cache.isMember(guildId, actorId)) throw notFound("unknown_guild");
  if (!cache.hasGuildPerm(guildId, actorId, Permission.MANAGE_CHANNELS)) throw forbidden("missing_permissions");
  const g = cache.guild(guildId)!;
  for (const it of items) {
    const c = g.channels.get(it.id);
    if (!c || c.type === "thread") throw badRequest("unknown_channel");
    if (it.parentId) {
      const p = g.channels.get(it.parentId);
      if (!p || p.type !== "category" || c.type === "category") throw badRequest("invalid_parent");
    }
  }
  await prisma.$transaction(
    items.map((it) =>
      prisma.channel.update({
        where: { id: it.id },
        data: { position: it.position, ...(it.parentId !== undefined ? { parentId: it.parentId } : {}) },
      })
    )
  );
  await cache.reloadGuild(guildId);
  const rows = await prisma.channel.findMany({ where: { guildId, type: { not: "thread" } }, select: { id: true, position: true, parentId: true } });
  toGuild(guildId, "CHANNEL_POSITIONS_UPDATE", { guildId, positions: rows });
}

// ── DMs ──────────────────────────────────────────────────────────────────────
async function relationship(a: string, b: string) {
  return prisma.relationship.findUnique({ where: { userId_targetId: { userId: a, targetId: b } } });
}

export async function openDm(userId: string, targetId: string): Promise<ChannelDTO> {
  if (userId === targetId) throw badRequest("cannot_dm_self");
  const target = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true } });
  if (!target) throw notFound("unknown_user");
  const [mine, theirs] = await Promise.all([relationship(userId, targetId), relationship(targetId, userId)]);
  if (mine?.type === RelationshipType.BLOCKED || theirs?.type === RelationshipType.BLOCKED) throw forbidden("blocked");

  for (const cid of cache.userPrivateIds(userId)) {
    const p = cache.privates.get(cid);
    if (p?.type === "dm" && p.recipients.has(targetId)) {
      await prisma.channelRecipient.updateMany({ where: { channelId: cid, userId }, data: { closed: false } });
      const dto = (await loadDto(cid))!;
      toUser(userId, "CHANNEL_CREATE", dto);
      return dto;
    }
  }
  if (mine?.type !== RelationshipType.FRIEND && !cache.sharesGuild(userId, targetId)) throw forbidden("cannot_dm");

  const id = ulid();
  await prisma.channel.create({
    data: {
      id,
      type: "dm",
      recipients: { create: [{ userId, closed: false }, { userId: targetId, closed: true }] },
    },
  });
  cache.setPrivate({ id, type: "dm", ownerId: null, recipients: new Set([userId, targetId]) });
  const dto = (await loadDto(id))!;
  toUser(userId, "CHANNEL_CREATE", dto);
  return dto;
}

async function assertFriends(userId: string, ids: string[]) {
  const rows = await prisma.relationship.findMany({ where: { userId, targetId: { in: ids }, type: RelationshipType.FRIEND }, select: { targetId: true } });
  if (rows.length !== new Set(ids).size) throw forbidden("friends_only");
}

export async function createGroupDm(userId: string, recipients: string[], name?: string): Promise<ChannelDTO> {
  const others = [...new Set(recipients)].filter((r) => r !== userId);
  if (!others.length) throw badRequest("no_recipients");
  if (others.length > LIMITS.groupDmMax - 1) throw badRequest("too_many_recipients");
  await assertFriends(userId, others);
  const id = ulid();
  const all = [userId, ...others];
  await prisma.channel.create({
    data: { id, type: "group_dm", name: name ?? "", ownerId: userId, recipients: { create: all.map((u) => ({ userId: u })) } },
  });
  cache.setPrivate({ id, type: "group_dm", ownerId: userId, recipients: new Set(all) });
  const dto = (await loadDto(id))!;
  toUsers(all, "CHANNEL_CREATE", dto);
  return dto;
}

export async function addGroupRecipient(actorId: string, channelId: string, userId: string) {
  const p = cache.privates.get(channelId);
  if (!p || p.type !== "group_dm" || !p.recipients.has(actorId)) throw notFound("unknown_channel");
  if (p.recipients.has(userId)) return;
  if (p.recipients.size >= LIMITS.groupDmMax) throw badRequest("too_many_recipients");
  await assertFriends(actorId, [userId]);
  await prisma.channelRecipient.create({ data: { channelId, userId } });
  cache.setPrivate({ ...p, recipients: new Set([...p.recipients, userId]) });
  const dto = (await loadDto(channelId))!;
  toUser(userId, "CHANNEL_CREATE", dto);
  toUsers([...p.recipients], "CHANNEL_UPDATE", dto);
}

export async function removeGroupRecipient(actorId: string, channelId: string, userId: string) {
  const p = cache.privates.get(channelId);
  if (!p || p.type !== "group_dm" || !p.recipients.has(actorId)) throw notFound("unknown_channel");
  if (actorId !== userId && p.ownerId !== actorId) throw forbidden("owner_only");
  if (!p.recipients.has(userId)) return;
  const vs = voice.get(userId);
  if (vs?.channelId === channelId) await voice.kick(userId);
  await prisma.channelRecipient.delete({ where: { channelId_userId: { channelId, userId } } });
  const rest = [...p.recipients].filter((u) => u !== userId);
  toUser(userId, "CHANNEL_DELETE", { id: channelId, guildId: null });
  if (!rest.length) {
    await prisma.channel.delete({ where: { id: channelId } });
    cache.removeChannel(channelId);
    return;
  }
  const ownerId = p.ownerId === userId ? rest[0] : p.ownerId;
  if (ownerId !== p.ownerId) await prisma.channel.update({ where: { id: channelId }, data: { ownerId } });
  cache.setPrivate({ ...p, ownerId, recipients: new Set(rest) });
  const dto = (await loadDto(channelId))!;
  toUsers(rest, "CHANNEL_UPDATE", dto);
}

// ── threads ──────────────────────────────────────────────────────────────────
export async function createThread(actorId: string, parentId: string, name: string, messageId?: string): Promise<ChannelDTO> {
  const parent = cache.channel(parentId);
  if (!parent || (parent.type !== "text" && parent.type !== "announcement")) throw badRequest("threads_unsupported");
  const bits = cache.channelPerms(parentId, actorId);
  if (!hasPerm(bits, Permission.VIEW_CHANNEL)) throw notFound("unknown_channel");
  if (!hasPerm(bits, Permission.CREATE_THREADS)) throw forbidden("missing_permissions");
  if (messageId) {
    const m = await prisma.message.findUnique({ where: { id: messageId }, select: { channelId: true, threadId: true } });
    if (!m || m.channelId !== parentId) throw notFound("unknown_message");
    if (m.threadId) {
      const existing = await loadDto(m.threadId);
      if (existing) return existing;
    }
  }
  const id = ulid();
  await prisma.channel.create({
    data: { id, type: "thread", guildId: parent.guildId, parentId, name, ownerId: actorId, starterMessageId: messageId ?? null, position: 0 },
  });
  if (messageId) await prisma.message.update({ where: { id: messageId }, data: { threadId: id } });
  const row = await prisma.channel.findUnique({ where: { id }, include: channelInclude });
  cache.setChannel(row!);
  const dto = toDto(row!);
  toChannel(id, "CHANNEL_CREATE", dto);
  if (messageId) {
    const starter = await loadMessage(messageId);
    if (starter) toChannel(parentId, "MESSAGE_UPDATE", starter);
  } else {
    await createMessage(actorId, parentId, { content: name }, { type: MessageType.THREAD_CREATED, meta: { threadId: id } });
  }
  return dto;
}

export async function listThreads(userId: string, parentId: string, archived: boolean): Promise<ChannelDTO[]> {
  if (!cache.canView(parentId, userId)) throw notFound("unknown_channel");
  const rows = await prisma.channel.findMany({
    where: { parentId, type: "thread", archived },
    orderBy: { lastMessageId: "desc" },
    take: 100,
    include: channelInclude,
  });
  return rows.map(toDto);
}
