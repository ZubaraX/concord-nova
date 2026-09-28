// Prisma rows → wire DTOs. Message serialization batch-loads everything it
// needs (reply previews, poll votes, thread info) in a constant number of queries.
import type { Prisma } from "@prisma/client";
import type {
  AttachmentDTO,
  ChannelDTO,
  ChannelType,
  EmbedDTO,
  EmojiDTO,
  GuildBaseDTO,
  MemberDTO,
  MessageDTO,
  MessageReferenceDTO,
  PollDTO,
  ProfileDTO,
  ReactionDTO,
  RoleDTO,
  SelfUserDTO,
  UserDTO,
} from "@nova/shared";
import { prisma, jsonParse } from "../db";
import { publicUrl } from "../lib/files";
import { cache } from "../state/cache";

export const userSelect = {
  id: true,
  username: true,
  displayName: true,
  avatar: true,
  accentColor: true,
  flags: true,
} as const satisfies Prisma.UserSelect;

type UserRow = Prisma.UserGetPayload<{ select: typeof userSelect }>;

export function toUser(u: UserRow): UserDTO {
  return { id: u.id, username: u.username, displayName: u.displayName, avatar: u.avatar, accentColor: u.accentColor, flags: u.flags };
}

export const profileSelect = { ...userSelect, banner: true, bio: true, pronouns: true, createdAt: true } as const satisfies Prisma.UserSelect;

export function toProfile(u: Prisma.UserGetPayload<{ select: typeof profileSelect }>): ProfileDTO {
  return { ...toUser(u), banner: u.banner, bio: u.bio, pronouns: u.pronouns, createdAt: u.createdAt.toISOString() };
}

export function toSelf(u: Prisma.UserGetPayload<object>): SelfUserDTO {
  const expired = u.customStatusExpires && u.customStatusExpires.getTime() < Date.now();
  return {
    ...toProfile(u),
    email: u.email,
    status: (["online", "idle", "dnd", "invisible"].includes(u.status) ? u.status : "online") as SelfUserDTO["status"],
    customStatus:
      !expired && (u.customStatusText || u.customStatusEmoji)
        ? { text: u.customStatusText, emoji: u.customStatusEmoji, expiresAt: u.customStatusExpires?.getTime() ?? null }
        : null,
  };
}

export function toRole(r: { id: string; guildId: string; name: string; color: number; permissions: string; position: number; hoist: boolean; mentionable: boolean }): RoleDTO {
  return { id: r.id, guildId: r.guildId, name: r.name, color: r.color, permissions: r.permissions, position: r.position, hoist: r.hoist, mentionable: r.mentionable };
}

export const channelInclude = {
  overwrites: true,
  recipients: { select: { userId: true } },
} as const satisfies Prisma.ChannelInclude;

export type ChannelRow = Prisma.ChannelGetPayload<{ include: typeof channelInclude }>;

export function toChannel(c: ChannelRow): ChannelDTO {
  return {
    id: c.id,
    type: c.type as ChannelType,
    guildId: c.guildId,
    parentId: c.parentId,
    name: c.name,
    topic: c.topic,
    position: c.position,
    nsfw: c.nsfw,
    slowmode: c.slowmode,
    bitrate: c.bitrate,
    userLimit: c.userLimit,
    lastMessageId: c.lastMessageId,
    lastPinAt: c.lastPinAt?.toISOString() ?? null,
    overwrites: c.overwrites.map((o) => ({ id: o.targetId, type: o.type === "member" ? "member" : "role", allow: o.allow, deny: o.deny })),
    recipients: c.recipients.map((r) => r.userId),
    ownerId: c.ownerId,
    icon: c.icon,
    thread:
      c.type === "thread"
        ? { archived: c.archived, locked: c.locked, messageCount: c.messageCount, starterMessageId: c.starterMessageId }
        : null,
    createdAt: c.createdAt.toISOString(),
  };
}

export const memberInclude = { roles: { select: { roleId: true } } } as const satisfies Prisma.MemberInclude;

export function toMember(m: Prisma.MemberGetPayload<{ include: typeof memberInclude }>): MemberDTO {
  return {
    guildId: m.guildId,
    userId: m.userId,
    nick: m.nick,
    roles: m.roles.map((r) => r.roleId),
    joinedAt: m.joinedAt.toISOString(),
    timeoutUntil: m.timeoutUntil && m.timeoutUntil.getTime() > Date.now() ? m.timeoutUntil.toISOString() : null,
  };
}

export function toEmoji(e: { id: string; guildId: string; name: string; path: string; animated: boolean }): EmojiDTO {
  return { id: e.id, guildId: e.guildId, name: e.name, url: e.path, animated: e.animated };
}

export function toGuildBase(g: { id: string; name: string; icon: string | null; banner: string | null; description: string | null; ownerId: string; systemChannelId: string | null; createdAt: Date }): GuildBaseDTO {
  return {
    id: g.id,
    name: g.name,
    icon: g.icon,
    banner: g.banner,
    description: g.description,
    ownerId: g.ownerId,
    systemChannelId: g.systemChannelId,
    createdAt: g.createdAt.toISOString(),
  };
}

export function toAttachment(a: {
  id: string;
  filename: string;
  path: string;
  size: bigint;
  contentType: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  waveform: string | null;
  flags: number;
}): AttachmentDTO {
  return {
    id: a.id,
    filename: a.filename,
    url: publicUrl(a.path),
    size: Number(a.size),
    contentType: a.contentType,
    width: a.width,
    height: a.height,
    duration: a.duration,
    waveform: a.waveform,
    flags: a.flags,
  };
}

// ── messages ────────────────────────────────────────────────────────────────
export const messageInclude = {
  author: { select: userSelect },
  attachments: { orderBy: { id: "asc" } },
  reactions: { select: { emoji: true, userId: true, createdAt: true }, orderBy: { createdAt: "asc" } },
} as const satisfies Prisma.MessageInclude;

export type MessageRow = Prisma.MessageGetPayload<{ include: typeof messageInclude }>;

interface StoredPoll {
  question: string;
  allowMultiselect: boolean;
  expiresAt: string | null;
  finalized: boolean;
  answers: { id: string; text: string; emoji: string | null }[];
}

export function aggregateReactions(rows: { emoji: string; userId: string }[]): ReactionDTO[] {
  const map = new Map<string, ReactionDTO>();
  for (const r of rows) {
    let e = map.get(r.emoji);
    if (!e) map.set(r.emoji, (e = { emoji: r.emoji, count: 0, users: [] }));
    e.count++;
    if (e.users.length < 500) e.users.push(r.userId);
  }
  return [...map.values()];
}

export function buildPoll(raw: string | null, votes: { answerId: string; userId: string }[]): PollDTO | null {
  const p = jsonParse<StoredPoll | null>(raw, null);
  if (!p) return null;
  const expired = !!p.expiresAt && new Date(p.expiresAt).getTime() <= Date.now();
  return {
    question: p.question,
    allowMultiselect: p.allowMultiselect,
    expiresAt: p.expiresAt,
    finalized: p.finalized || expired,
    answers: p.answers.map((a) => {
      const voters = votes.filter((v) => v.answerId === a.id).map((v) => v.userId);
      return { id: a.id, text: a.text, emoji: a.emoji, votes: voters.length, voters: voters.slice(0, 1000) };
    }),
  };
}

export async function toMessages(rows: MessageRow[]): Promise<MessageDTO[]> {
  if (!rows.length) return [];
  const replyIds = [...new Set(rows.map((r) => r.replyToId).filter((x): x is string => !!x))];
  const pollIds = rows.filter((r) => r.poll).map((r) => r.id);
  const threadIds = [...new Set(rows.map((r) => r.threadId).filter((x): x is string => !!x))];

  const [replies, votes, threads] = await Promise.all([
    replyIds.length
      ? prisma.message.findMany({
          where: { id: { in: replyIds } },
          select: { id: true, channelId: true, content: true, author: { select: userSelect }, _count: { select: { attachments: true } } },
        })
      : [],
    pollIds.length ? prisma.pollVote.findMany({ where: { messageId: { in: pollIds } }, select: { messageId: true, answerId: true, userId: true } }) : [],
    threadIds.length
      ? prisma.channel.findMany({ where: { id: { in: threadIds } }, select: { id: true, name: true, messageCount: true, lastMessageId: true } })
      : [],
  ]);
  const replyMap = new Map(replies.map((r) => [r.id, r]));
  const threadMap = new Map(threads.map((t) => [t.id, t]));

  return rows.map((m) => {
    let replyTo: MessageReferenceDTO | null = null;
    if (m.replyToId) {
      const r = replyMap.get(m.replyToId);
      replyTo = r
        ? { id: r.id, channelId: r.channelId, author: toUser(r.author), content: r.content.slice(0, 400), attachments: r._count.attachments, deleted: false }
        : { id: m.replyToId, channelId: m.channelId, author: null, content: "", attachments: 0, deleted: true };
    }
    const t = m.threadId ? threadMap.get(m.threadId) : undefined;
    return {
      id: m.id,
      channelId: m.channelId,
      guildId: cache.guildOf(m.channelId),
      author: toUser(m.author),
      type: m.type,
      content: m.content,
      createdAt: m.createdAt.toISOString(),
      editedAt: m.editedAt?.toISOString() ?? null,
      pinned: m.pinned,
      flags: m.flags,
      mentions: jsonParse<string[]>(m.mentions, []),
      mentionRoles: jsonParse<string[]>(m.mentionRoles, []),
      mentionEveryone: m.mentionEveryone,
      attachments: m.attachments.map(toAttachment),
      embeds: jsonParse<EmbedDTO[]>(m.embeds, []),
      reactions: aggregateReactions(m.reactions),
      replyTo,
      nonce: m.nonce,
      poll: m.poll ? buildPoll(m.poll, votes.filter((v) => v.messageId === m.id)) : null,
      thread: t ? { id: t.id, name: t.name, messageCount: t.messageCount, lastMessageId: t.lastMessageId } : null,
      meta: jsonParse<Record<string, unknown> | null>(m.meta, null),
    };
  });
}

export async function toMessage(row: MessageRow): Promise<MessageDTO> {
  return (await toMessages([row]))[0];
}

export async function loadMessage(id: string): Promise<MessageDTO | null> {
  const row = await prisma.message.findUnique({ where: { id }, include: messageInclude });
  return row ? toMessage(row) : null;
}
