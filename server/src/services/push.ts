// Self-hosted push for the Android app (no Google FCM): the phone's foreground
// service holds one SSE stream per device. Here we keep those streams and
// decide who deserves a notification for a message, honoring mute/level
// settings, DND, blocks — and skipping phones while the user is active at a
// computer (like Discord does).
import type { ServerResponse } from "node:http";
import { RelationshipType, isGifLink, type MessageDTO } from "@nova/shared";
import { prisma } from "../db";
import { presence } from "../state/presence";
import { cache } from "../state/cache";

export interface PushEvent {
  type: "dm" | "mention" | "message" | "call" | "call_end";
  title: string;
  body: string;
  channelId: string;
  guildId?: string | null;
  messageId?: string;
  icon?: string | null;
  /** Message author (for conversation-style notifications). */
  sender?: string;
  authorId?: string;
  /** "#general · Server" / group DM name; absent for 1:1 DMs. */
  conversation?: string;
  group?: boolean;
}

interface Stream {
  sid: string;
  res: ServerResponse;
}

const streams = new Map<string, Set<Stream>>();

export function addPushStream(userId: string, sid: string, res: ServerResponse): () => void {
  let set = streams.get(userId);
  if (!set) streams.set(userId, (set = new Set()));
  const s = { sid, res };
  set.add(s);
  return () => {
    set!.delete(s);
    if (!set!.size) streams.delete(userId);
  };
}

export function closeSessionStreams(sid: string) {
  for (const set of streams.values()) for (const s of set) if (s.sid === sid) s.res.end();
}

export const hasPushStream = (userId: string) => !!streams.get(userId)?.size;

export function pushToUser(userId: string, ev: PushEvent) {
  const set = streams.get(userId);
  if (!set?.size) return;
  const frame = `data: ${JSON.stringify(ev)}\n\n`;
  for (const s of set) {
    try {
      s.res.write(frame);
    } catch {
      set.delete(s);
    }
  }
}

function preview(m: MessageDTO): string {
  if (m.poll) return `📊 ${m.poll.question}`;
  if (isGifLink(m.content)) return "GIF";
  const text = m.content
    .replace(/<@!?([0-9A-Z]{26})>/g, "@…")
    .replace(/<@&[0-9A-Z]{26}>/g, "@роль")
    .replace(/<#[0-9A-Z]{26}>/g, "#канал")
    .replace(/<a?:(\w+):[0-9A-Z]{26}>/g, ":$1:")
    .slice(0, 200);
  if (text) return text;
  if (m.attachments.length) return m.attachments.some((a) => a.duration) ? "🎤 Голосовое сообщение" : `📎 ${m.attachments[0].filename}`;
  return "";
}

/** Decide and send Android pushes for a freshly created message. */
export async function pushForMessage(m: MessageDTO, recipients: string[], mentioned: Set<string>, everyone: boolean) {
  if (m.flags & (1 << 12)) return; // silent message
  const candidates = recipients.filter((u) => u !== m.author.id && hasPushStream(u) && !presence.isActiveOnComputer(u));
  if (!candidates.length) return;
  const guildId = m.guildId;
  const targets = guildId ? [m.channelId, guildId] : [m.channelId];
  const [settings, users, blocks] = await Promise.all([
    prisma.notificationSetting.findMany({ where: { userId: { in: candidates }, targetId: { in: targets } } }),
    prisma.user.findMany({ where: { id: { in: candidates } }, select: { id: true, status: true } }),
    prisma.relationship.findMany({ where: { userId: { in: candidates }, targetId: m.author.id, type: RelationshipType.BLOCKED }, select: { userId: true } }),
  ]);
  const blocked = new Set(blocks.map((b) => b.userId));
  const dnd = new Set(users.filter((u) => u.status === "dnd").map((u) => u.id));
  const now = Date.now();
  const author = m.author.displayName || m.author.username;
  const body = preview(m);
  const where = await prisma.channel.findUnique({ where: { id: m.channelId }, select: { name: true, guild: { select: { name: true } } } });
  const conversation = guildId ? `#${where?.name ?? "канал"} · ${where?.guild?.name ?? ""}` : undefined;
  const common = { sender: author, authorId: m.author.id, channelId: m.channelId, messageId: m.id, icon: m.author.avatar };

  for (const uid of candidates) {
    if (blocked.has(uid) || dnd.has(uid)) continue;
    const ch = settings.find((s) => s.userId === uid && s.targetId === m.channelId);
    const gs = guildId ? settings.find((s) => s.userId === uid && s.targetId === guildId) : undefined;
    const isMuted = (s?: { muted: boolean; muteUntil: Date | null }) => !!s?.muted && (!s.muteUntil || s.muteUntil.getTime() > now);
    const level = (ch && ch.level !== "default" ? ch.level : gs && gs.level !== "default" ? gs.level : guildId ? "mentions" : "all") as string;
    if (level === "none") continue;
    const suppressEveryone = !!gs?.suppressEveryone;
    const isMention = mentioned.has(uid) || (everyone && !suppressEveryone);

    if (!guildId) {
      if (isMuted(ch)) continue;
      const group = cache.privates.get(m.channelId)?.type === "group_dm";
      pushToUser(uid, {
        ...common,
        type: "dm",
        title: group ? `${author} · ${where?.name || "группа"}` : author,
        body,
        conversation: group ? where?.name || "Группа" : undefined,
        group,
      });
      continue;
    }
    if ((isMuted(ch) || isMuted(gs)) && !isMention) continue;
    if (level === "all" || isMention) {
      pushToUser(uid, {
        ...common,
        type: isMention ? "mention" : "message",
        title: isMention ? `${author} упомянул(а) вас` : author,
        body,
        guildId,
        conversation,
        group: true,
      });
    }
  }
}
