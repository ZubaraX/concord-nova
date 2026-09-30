// Messages: create (idempotent by nonce), edit, delete, history, pins, search,
// polls. Every path checks channel permissions through the cache and fans out
// only to users who can see the channel.
import {
  AttachmentFlags,
  MessageFlags,
  MessageType,
  Permission,
  RelationshipType,
  SYSTEM_MESSAGE_TYPES,
  extractMentions,
  hasPerm,
  ulid,
  type MessageCreateInput,
  type MessageDTO,
  type SearchResultDTO,
} from "@nova/shared";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { config } from "../config";
import { ApiError, badRequest, forbidden, notFound, tooMany } from "../lib/errors";
import { limits } from "../lib/rate";
import { deleteStored } from "../lib/files";
import { cache } from "../state/cache";
import { toChannel, toUser } from "../gateway/io";
import { buildPoll, channelInclude, loadMessage, messageInclude, toChannel as toChannelDto, toMessage, toMessages } from "./serialize";
import { scheduleEmbeds } from "./embeds";
import { pushForMessage } from "./push";
import { audit } from "./audit";
import { forgetFiles } from "./gifs";

export const normalizeSearch = (s: string) => s.toLowerCase().replace(/ё/g, "е");

const slowmodeLast = new Map<string, number>();

export interface SystemMessageOpts {
  type: number;
  meta?: Record<string, unknown> | null;
  replyTo?: string;
}

async function isBlockedBetween(a: string, b: string): Promise<boolean> {
  const n = await prisma.relationship.count({
    where: {
      type: RelationshipType.BLOCKED,
      OR: [
        { userId: a, targetId: b },
        { userId: b, targetId: a },
      ],
    },
  });
  return n > 0;
}

/** Throws unless the user can see the channel; returns their permission bits. */
export function requireView(userId: string, channelId: string, alsoHistory = false): bigint {
  const bits = cache.channelPerms(channelId, userId);
  if (!hasPerm(bits, Permission.VIEW_CHANNEL)) throw notFound("unknown_channel");
  if (alsoHistory && !hasPerm(bits, Permission.READ_MESSAGE_HISTORY)) throw forbidden("missing_permissions");
  return bits;
}

async function bumpMentionCounts(channelId: string, userIds: string[]) {
  const ids = [...new Set(userIds)];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const values = chunk.map(() => `(?, ?, NULL, 1)`).join(",");
    const params = chunk.flatMap((u) => [u, channelId]);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "ReadState" ("userId","channelId","lastReadId","mentionCount") VALUES ${values}
       ON CONFLICT("userId","channelId") DO UPDATE SET "mentionCount" = "mentionCount" + 1`,
      ...params
    );
  }
}

export async function createMessage(
  authorId: string,
  channelId: string,
  input: MessageCreateInput,
  system?: SystemMessageOpts
): Promise<MessageDTO> {
  const bits = cache.channelPerms(channelId, authorId);
  const guildId = cache.guildOf(channelId);
  const priv = cache.privates.get(channelId);
  if (!guildId && !priv) throw notFound("unknown_channel");

  if (!system) {
    if (!hasPerm(bits, Permission.VIEW_CHANNEL)) throw notFound("unknown_channel");
    if (!hasPerm(bits, Permission.SEND_MESSAGES)) throw forbidden("cannot_send");
    limits.messages.consume(authorId);
    if (priv?.type === "dm") {
      const other = [...priv.recipients].find((u) => u !== authorId);
      if (other && (await isBlockedBetween(authorId, other))) throw forbidden("blocked");
    }
  }

  // Idempotent retries: the same nonce from the same author returns the original.
  if (input.nonce) {
    const existing = await prisma.message.findUnique({ where: { authorId_nonce: { authorId, nonce: input.nonce } }, include: messageInclude });
    if (existing) return toMessage(existing);
  }

  const ch = await prisma.channel.findUnique({ where: { id: channelId }, select: { type: true, slowmode: true, parentId: true, archived: true } });
  if (!ch) throw notFound("unknown_channel");

  if (!system && guildId && ch.slowmode > 0 && !hasPerm(bits, Permission.MANAGE_MESSAGES) && !hasPerm(bits, Permission.MANAGE_CHANNELS)) {
    const key = `${channelId}:${authorId}`;
    const wait = (slowmodeLast.get(key) ?? 0) + ch.slowmode * 1000 - Date.now();
    if (wait > 0) throw tooMany(wait, "slowmode");
  }

  const content = (input.content ?? "").replace(/\r\n?/g, "\n").trim();
  if (content.length > config.MAX_MESSAGE_LENGTH) throw badRequest("message_too_long");

  // Attachments must be the author's own, unclaimed uploads.
  const attIds = [...new Set(input.attachments ?? [])];
  const atts = attIds.length
    ? await prisma.attachment.findMany({ where: { id: { in: attIds }, uploaderId: authorId, messageId: null }, select: { id: true, flags: true } })
    : [];
  if (atts.length !== attIds.length) throw badRequest("invalid_attachments");
  const isVoice = atts.length > 0 && atts.every((a) => a.flags & AttachmentFlags.VOICE_MESSAGE);
  if (!system && atts.length) {
    const need = isVoice ? Permission.SEND_VOICE_MESSAGES : Permission.ATTACH_FILES;
    if (!hasPerm(bits, need)) throw forbidden("cannot_attach");
  }
  if (!system && input.poll && !hasPerm(bits, Permission.SEND_POLLS)) throw forbidden("cannot_poll");
  if (!system && !content && !atts.length && !input.poll) throw badRequest("empty_message");

  let replyAuthor: string | null = null;
  const replyToId = system?.replyTo ?? input.replyTo;
  if (replyToId) {
    const ref = await prisma.message.findUnique({ where: { id: replyToId }, select: { channelId: true, authorId: true } });
    if (!ref || ref.channelId !== channelId) {
      if (!system) throw badRequest("invalid_reply");
    } else replyAuthor = ref.authorId;
  }

  // Mentions — only people who can actually see this channel count.
  const viewers = new Set(cache.viewers(channelId));
  const ext = extractMentions(content);
  const mentionUsers = new Set(ext.users.filter((u) => viewers.has(u)));
  if (!system && replyAuthor && replyAuthor !== authorId && input.replyMention !== false && viewers.has(replyAuthor)) mentionUsers.add(replyAuthor);
  let mentionRoles: string[] = [];
  let everyone = false;
  if (guildId) {
    const g = cache.guild(guildId)!;
    const canEveryone = hasPerm(bits, Permission.MENTION_EVERYONE);
    mentionRoles = ext.roles.filter((r) => {
      const role = g.roles.get(r);
      return role && r !== guildId && (role.mentionable || canEveryone);
    });
    everyone = (ext.everyone || ext.here) && canEveryone;
  }

  const id = ulid();
  const type = system?.type ?? (replyToId ? MessageType.REPLY : MessageType.DEFAULT);
  let flags = 0;
  if (input.silent) flags |= MessageFlags.SUPPRESS_NOTIFICATIONS;
  if (isVoice) flags |= MessageFlags.VOICE_MESSAGE;
  const poll = input.poll
    ? JSON.stringify({
        question: input.poll.question,
        allowMultiselect: input.poll.allowMultiselect,
        expiresAt: input.poll.durationHours ? new Date(Date.now() + input.poll.durationHours * 3_600_000).toISOString() : null,
        finalized: false,
        answers: input.poll.answers.map((a, i) => ({ id: String(i + 1), text: a.text, emoji: a.emoji ?? null })),
      })
    : null;

  // Who gets a mention badge: explicit + role mentions + @everyone; every DM message counts.
  const counted = new Set<string>();
  if (!guildId) for (const u of viewers) counted.add(u);
  else if (everyone) for (const u of viewers) counted.add(u);
  else {
    for (const u of mentionUsers) counted.add(u);
    if (mentionRoles.length) {
      const g = cache.guild(guildId)!;
      for (const [uid, m] of g.members) if (viewers.has(uid) && m.roles.some((r) => mentionRoles.includes(r))) counted.add(uid);
    }
  }
  counted.delete(authorId);
  if (flags & MessageFlags.SUPPRESS_NOTIFICATIONS) counted.clear();

  try {
    await prisma.$transaction(async (tx) => {
      await tx.message.create({
        data: {
          id,
          channelId,
          authorId,
          type,
          content,
          searchText: normalizeSearch(content),
          nonce: input.nonce ?? null,
          replyToId: replyToId ?? null,
          flags,
          mentions: JSON.stringify([...mentionUsers]),
          mentionRoles: JSON.stringify(mentionRoles),
          mentionEveryone: everyone,
          poll,
          meta: system?.meta ? JSON.stringify(system.meta) : null,
        },
      });
      if (atts.length) await tx.attachment.updateMany({ where: { id: { in: attIds } }, data: { messageId: id } });
      const spoilers = (input.spoilers ?? []).filter((s) => attIds.includes(s));
      if (spoilers.length) {
        await tx.attachment.updateMany({ where: { id: { in: spoilers }, flags: 0 }, data: { flags: AttachmentFlags.SPOILER } });
        await tx.attachment.updateMany({ where: { id: { in: spoilers }, flags: AttachmentFlags.VOICE_MESSAGE }, data: { flags: AttachmentFlags.VOICE_MESSAGE | AttachmentFlags.SPOILER } });
      }
      await tx.channel.update({
        where: { id: channelId },
        data: { lastMessageId: id, ...(ch.type === "thread" ? { messageCount: { increment: 1 } } : {}) },
      });
      await tx.readState.upsert({
        where: { userId_channelId: { userId: authorId, channelId } },
        create: { userId: authorId, channelId, lastReadId: id },
        update: { lastReadId: id },
      });
    });
  } catch (e) {
    // Two concurrent retries with one nonce: the loser returns the winner's row.
    if ((e as { code?: string }).code === "P2002" && input.nonce) {
      const existing = await prisma.message.findUnique({ where: { authorId_nonce: { authorId, nonce: input.nonce } }, include: messageInclude });
      if (existing) return toMessage(existing);
    }
    throw e;
  }
  if (counted.size) await bumpMentionCounts(channelId, [...counted]);

  const dto = (await loadMessage(id))!;

  // Closed DMs reappear in the recipients' lists with this message.
  if (priv) {
    const closed = await prisma.channelRecipient.findMany({ where: { channelId, closed: true }, select: { userId: true } });
    if (closed.length) {
      await prisma.channelRecipient.updateMany({ where: { channelId, closed: true }, data: { closed: false } });
      const row = await prisma.channel.findUnique({ where: { id: channelId }, include: channelInclude });
      if (row) for (const c of closed) toUser(c.userId, "CHANNEL_CREATE", toChannelDto(row));
    }
  }

  toChannel(channelId, "MESSAGE_CREATE", dto);

  if (ch.type === "thread" && ch.parentId) {
    const starter = await prisma.message.findFirst({ where: { threadId: channelId }, include: messageInclude });
    if (starter) toChannel(ch.parentId, "MESSAGE_UPDATE", await toMessage(starter));
  }

  if (!system && guildId && ch.slowmode > 0) slowmodeLast.set(`${channelId}:${authorId}`, Date.now());
  // System messages (call logs, joins, pins) never push — calls ring separately.
  if (!system) void pushForMessage(dto, [...viewers], new Set(counted), everyone).catch(() => {});
  if (content && hasPerm(bits | (system ? Permission.EMBED_LINKS : 0n), Permission.EMBED_LINKS)) scheduleEmbeds(id, content);
  return dto;
}

export async function editMessage(userId: string, messageId: string, content: string, suppressEmbeds?: boolean): Promise<MessageDTO> {
  const msg = await prisma.message.findUnique({ where: { id: messageId } });
  if (!msg) throw notFound("unknown_message");
  const bits = requireView(userId, msg.channelId);
  const own = msg.authorId === userId;
  if (!own) {
    // Moderators may only strip embeds from others' messages.
    if (!(suppressEmbeds && hasPerm(bits, Permission.MANAGE_MESSAGES))) throw forbidden("not_author");
    await prisma.message.update({ where: { id: messageId }, data: { embeds: "[]", flags: msg.flags | MessageFlags.SUPPRESS_EMBEDS } });
  } else {
    if (SYSTEM_MESSAGE_TYPES.has(msg.type)) throw forbidden("system_message");
    const text = content.replace(/\r\n?/g, "\n").trim();
    if (text.length > config.MAX_MESSAGE_LENGTH) throw badRequest("message_too_long");
    const hasAttachments = (await prisma.attachment.count({ where: { messageId } })) > 0;
    if (!text && !hasAttachments && !msg.poll) throw badRequest("empty_message");
    const viewers = new Set(cache.viewers(msg.channelId));
    const ext = extractMentions(text);
    const guildId = cache.guildOf(msg.channelId);
    const canEveryone = !!guildId && hasPerm(bits, Permission.MENTION_EVERYONE);
    const g = guildId ? cache.guild(guildId) : undefined;
    const flags = suppressEmbeds ? msg.flags | MessageFlags.SUPPRESS_EMBEDS : suppressEmbeds === false ? msg.flags & ~MessageFlags.SUPPRESS_EMBEDS : msg.flags;
    const urlsChanged = text !== msg.content;
    await prisma.message.update({
      where: { id: messageId },
      data: {
        content: text,
        searchText: normalizeSearch(text),
        editedAt: new Date(),
        flags,
        mentions: JSON.stringify(ext.users.filter((u) => viewers.has(u))),
        mentionRoles: JSON.stringify(g ? ext.roles.filter((r) => g.roles.get(r) && (g.roles.get(r)!.mentionable || canEveryone)) : []),
        mentionEveryone: (ext.everyone || ext.here) && canEveryone,
        ...(flags & MessageFlags.SUPPRESS_EMBEDS ? { embeds: "[]" } : {}),
      },
    });
    if (urlsChanged && !(flags & MessageFlags.SUPPRESS_EMBEDS) && hasPerm(bits, Permission.EMBED_LINKS)) {
      if (!scheduleEmbeds(messageId, text)) await prisma.message.update({ where: { id: messageId }, data: { embeds: "[]" } });
    }
  }
  const dto = (await loadMessage(messageId))!;
  toChannel(msg.channelId, "MESSAGE_UPDATE", dto);
  return dto;
}

async function removeFiles(paths: string[]) {
  for (const p of paths) await deleteStored(p);
  await forgetFiles(paths).catch(() => {});
}

export async function deleteMessage(userId: string, messageId: string, reason?: string) {
  const msg = await prisma.message.findUnique({ where: { id: messageId }, include: { attachments: { select: { path: true } } } });
  if (!msg) throw notFound("unknown_message");
  const bits = requireView(userId, msg.channelId);
  const guildId = cache.guildOf(msg.channelId);
  const own = msg.authorId === userId;
  const mod = !!guildId && hasPerm(bits, Permission.MANAGE_MESSAGES);
  if (!own && !mod) throw forbidden("not_author");
  if (SYSTEM_MESSAGE_TYPES.has(msg.type) && guildId && !mod) throw forbidden("system_message");
  await prisma.message.delete({ where: { id: messageId } });
  await prisma.bookmark.deleteMany({ where: { messageId } }).catch(() => {});
  toChannel(msg.channelId, "MESSAGE_DELETE", { id: messageId, channelId: msg.channelId });
  if (!own && guildId) await audit(guildId, userId, "message_delete", msg.authorId, { channelId: msg.channelId }, reason);
  void removeFiles(msg.attachments.map((a) => a.path));
}

/** Moderation helper: delete a user's recent messages across a guild (used by bans). */
export async function purgeUserMessages(guildId: string, userId: string, sinceMs: number) {
  if (sinceMs <= 0) return;
  const channels = [...(cache.guild(guildId)?.channels.keys() ?? [])];
  const rows = await prisma.message.findMany({
    where: { channelId: { in: channels }, authorId: userId, createdAt: { gte: new Date(Date.now() - sinceMs) } },
    select: { id: true, channelId: true, attachments: { select: { path: true } } },
  });
  if (!rows.length) return;
  await prisma.message.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
  const byChannel = new Map<string, string[]>();
  for (const r of rows) byChannel.set(r.channelId, [...(byChannel.get(r.channelId) ?? []), r.id]);
  for (const [channelId, ids] of byChannel) toChannel(channelId, "MESSAGE_DELETE_BULK", { ids, channelId });
  void removeFiles(rows.flatMap((r) => r.attachments.map((a) => a.path)));
}

export async function getMessages(
  userId: string,
  channelId: string,
  q: { before?: string; after?: string; around?: string; limit?: number }
): Promise<MessageDTO[]> {
  requireView(userId, channelId, true);
  const limit = Math.min(100, Math.max(1, q.limit ?? 50));
  if (q.around) {
    const half = Math.floor(limit / 2);
    const [older, newer] = await Promise.all([
      prisma.message.findMany({ where: { channelId, id: { lt: q.around } }, orderBy: { id: "desc" }, take: half, include: messageInclude }),
      prisma.message.findMany({ where: { channelId, id: { gte: q.around } }, orderBy: { id: "asc" }, take: limit - half, include: messageInclude }),
    ]);
    return toMessages([...older.reverse(), ...newer]);
  }
  if (q.after) {
    const rows = await prisma.message.findMany({ where: { channelId, id: { gt: q.after } }, orderBy: { id: "asc" }, take: limit, include: messageInclude });
    return toMessages(rows);
  }
  const rows = await prisma.message.findMany({
    where: { channelId, ...(q.before ? { id: { lt: q.before } } : {}) },
    orderBy: { id: "desc" },
    take: limit,
    include: messageInclude,
  });
  return toMessages(rows.reverse());
}

// ── pins ────────────────────────────────────────────────────────────────────
function canPin(userId: string, channelId: string): boolean {
  const bits = requireView(userId, channelId);
  return cache.privates.has(channelId) ? true : hasPerm(bits, Permission.MANAGE_MESSAGES);
}

export async function setPinned(userId: string, channelId: string, messageId: string, pinned: boolean) {
  if (!canPin(userId, channelId)) throw forbidden("missing_permissions");
  const msg = await prisma.message.findUnique({ where: { id: messageId }, select: { channelId: true, pinned: true, authorId: true } });
  if (!msg || msg.channelId !== channelId) throw notFound("unknown_message");
  if (msg.pinned === pinned) return;
  if (pinned && (await prisma.message.count({ where: { channelId, pinned: true } })) >= 250) throw badRequest("too_many_pins");
  const now = new Date();
  await prisma.message.update({ where: { id: messageId }, data: { pinned } });
  await prisma.channel.update({ where: { id: channelId }, data: { lastPinAt: now } });
  const dto = await loadMessage(messageId);
  if (dto) toChannel(channelId, "MESSAGE_UPDATE", dto);
  toChannel(channelId, "CHANNEL_PINS_UPDATE", { channelId, lastPinAt: now.toISOString() });
  const guildId = cache.guildOf(channelId);
  if (guildId && msg.authorId !== userId) await audit(guildId, userId, pinned ? "message_pin" : "message_unpin", messageId, { channelId });
  if (pinned) await createMessage(userId, channelId, { content: "" }, { type: MessageType.CHANNEL_PINNED_MESSAGE, replyTo: messageId });
}

export async function getPins(userId: string, channelId: string) {
  requireView(userId, channelId, true);
  const rows = await prisma.message.findMany({ where: { channelId, pinned: true }, orderBy: { id: "desc" }, include: messageInclude });
  return toMessages(rows);
}

// ── search ──────────────────────────────────────────────────────────────────
export interface SearchQuery {
  content?: string;
  authorId?: string;
  channelId?: string;
  mentions?: string;
  has?: string[];
  before?: string;
  after?: string;
  pinned?: boolean;
  offset?: number;
}

export async function searchMessages(userId: string, scope: { guildId?: string; channelId?: string }, q: SearchQuery): Promise<SearchResultDTO> {
  limits.search.consume(userId);
  let channelIds: string[];
  if (scope.channelId) {
    requireView(userId, scope.channelId, true);
    channelIds = [scope.channelId];
  } else if (scope.guildId) {
    if (!cache.isMember(scope.guildId, userId)) throw notFound("unknown_guild");
    channelIds = cache
      .visibleChannelIds(scope.guildId, userId)
      .filter((c) => cache.can(c, userId, Permission.READ_MESSAGE_HISTORY) && cache.channel(c)?.type !== "category");
    if (q.channelId) channelIds = channelIds.filter((c) => c === q.channelId);
  } else throw badRequest("scope_required");
  if (!channelIds.length) return { total: 0, messages: [] };

  const where: Prisma.MessageWhereInput = { channelId: { in: channelIds }, AND: [] };
  const and = where.AND as Prisma.MessageWhereInput[];
  const words = normalizeSearch(q.content ?? "").split(/\s+/).filter(Boolean).slice(0, 8);
  for (const w of words) and.push({ searchText: { contains: w } });
  if (q.authorId) and.push({ authorId: q.authorId });
  if (q.mentions) and.push({ mentions: { contains: q.mentions } });
  if (q.pinned) and.push({ pinned: true });
  if (q.before) and.push({ id: { lt: q.before } });
  if (q.after) and.push({ id: { gt: q.after } });
  for (const h of q.has ?? []) {
    if (h === "link") and.push({ content: { contains: "http" } });
    else if (h === "file") and.push({ attachments: { some: {} } });
    else if (h === "image") and.push({ attachments: { some: { contentType: { startsWith: "image/" } } } });
    else if (h === "video") and.push({ attachments: { some: { contentType: { startsWith: "video/" } } } });
    else if (h === "sound") and.push({ attachments: { some: { contentType: { startsWith: "audio/" } } } });
    else if (h === "poll") and.push({ poll: { not: null } });
    else if (h === "embed") and.push({ NOT: { embeds: "[]" } });
  }
  if (!and.length) throw badRequest("empty_query");
  and.push({ type: { in: [MessageType.DEFAULT, MessageType.REPLY] } });

  const [total, rows] = await Promise.all([
    prisma.message.count({ where }),
    prisma.message.findMany({ where, orderBy: { id: "desc" }, skip: Math.max(0, q.offset ?? 0), take: 25, include: messageInclude }),
  ]);
  return { total, messages: await toMessages(rows) };
}

/** Recent messages that mention the user (their inbox). */
export async function recentMentions(userId: string, before?: string): Promise<MessageDTO[]> {
  const channelIds: string[] = [];
  for (const gid of cache.userGuildIds(userId)) channelIds.push(...cache.visibleChannelIds(gid, userId));
  if (!channelIds.length) return [];
  const g = cache.userGuildIds(userId);
  const myRoles = g.flatMap((gid) => cache.member(gid, userId)?.roles ?? []);
  const rows = await prisma.message.findMany({
    where: {
      channelId: { in: channelIds },
      authorId: { not: userId },
      ...(before ? { id: { lt: before } } : {}),
      OR: [{ mentions: { contains: userId } }, { mentionEveryone: true }, ...myRoles.map((r) => ({ mentionRoles: { contains: r } }))],
    },
    orderBy: { id: "desc" },
    take: 25,
    include: messageInclude,
  });
  return toMessages(rows);
}

// ── polls ───────────────────────────────────────────────────────────────────
interface StoredPoll {
  question: string;
  allowMultiselect: boolean;
  expiresAt: string | null;
  finalized: boolean;
  answers: { id: string; text: string; emoji: string | null }[];
}

export async function votePoll(userId: string, channelId: string, messageId: string, answerIds: string[]) {
  requireView(userId, channelId, true);
  const msg = await prisma.message.findUnique({ where: { id: messageId }, select: { channelId: true, poll: true } });
  if (!msg || msg.channelId !== channelId || !msg.poll) throw notFound("unknown_message");
  const poll = JSON.parse(msg.poll) as StoredPoll;
  if (poll.finalized || (poll.expiresAt && new Date(poll.expiresAt).getTime() <= Date.now())) throw new ApiError(400, "poll_closed");
  const valid = new Set(poll.answers.map((a) => a.id));
  const picks = [...new Set(answerIds)].filter((a) => valid.has(a));
  if (picks.length !== answerIds.length) throw badRequest("invalid_answer");
  if (!poll.allowMultiselect && picks.length > 1) throw badRequest("single_choice");
  await prisma.$transaction([
    prisma.pollVote.deleteMany({ where: { messageId, userId } }),
    ...picks.map((answerId) => prisma.pollVote.create({ data: { messageId, answerId, userId } })),
  ]);
  await broadcastPoll(messageId, channelId);
}

export async function broadcastPoll(messageId: string, channelId: string) {
  const [msg, votes] = await Promise.all([
    prisma.message.findUnique({ where: { id: messageId }, select: { poll: true } }),
    prisma.pollVote.findMany({ where: { messageId }, select: { answerId: true, userId: true } }),
  ]);
  const poll = buildPoll(msg?.poll ?? null, votes);
  if (poll) toChannel(channelId, "MESSAGE_POLL_UPDATE", { channelId, messageId, poll });
}

export async function endPoll(userId: string, channelId: string, messageId: string) {
  const msg = await prisma.message.findUnique({ where: { id: messageId }, select: { channelId: true, poll: true, authorId: true } });
  if (!msg || msg.channelId !== channelId || !msg.poll) throw notFound("unknown_message");
  const bits = requireView(userId, channelId);
  if (msg.authorId !== userId && !hasPerm(bits, Permission.MANAGE_MESSAGES)) throw forbidden("not_author");
  const poll = JSON.parse(msg.poll) as StoredPoll;
  poll.finalized = true;
  await prisma.message.update({ where: { id: messageId }, data: { poll: JSON.stringify(poll) } });
  await broadcastPoll(messageId, channelId);
}

// ── bookmarks (saved messages) ──────────────────────────────────────────────
export async function listBookmarks(userId: string): Promise<MessageDTO[]> {
  const rows = await prisma.bookmark.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { message: { include: messageInclude } },
  });
  const visible = rows.filter((r) => cache.canView(r.message.channelId, userId));
  return toMessages(visible.map((r) => r.message));
}

export async function setBookmark(userId: string, messageId: string, on: boolean) {
  if (!on) {
    await prisma.bookmark.deleteMany({ where: { userId, messageId } });
    return;
  }
  const msg = await prisma.message.findUnique({ where: { id: messageId }, select: { channelId: true } });
  if (!msg) throw notFound("unknown_message");
  requireView(userId, msg.channelId, true);
  await prisma.bookmark.upsert({ where: { userId_messageId: { userId, messageId } }, create: { userId, messageId }, update: {} });
}
