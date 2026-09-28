// READY: the complete snapshot a client needs, sent on every (re)connect.
import type { GuildDTO, ReadyPayload, RelationshipTypeValue } from "@nova/shared";
import { prisma, jsonParse } from "../db";
import { cache } from "../state/cache";
import { presence } from "../state/presence";
import { voice } from "../state/voice";
import { buildGuild } from "../services/guilds";
import { channelInclude, toChannel, toSelf, toUser, userSelect } from "../services/serialize";
import { listNotificationSettings } from "../services/users";
import { serverInfo } from "../services/info";

export async function buildReady(userId: string, sid: string): Promise<ReadyPayload | null> {
  const me = await prisma.user.findUnique({ where: { id: userId } });
  if (!me) return null;
  const guildIds = cache.userGuildIds(userId);
  const [guildsRaw, privateRows, rels, readStates, notificationSettings] = await Promise.all([
    Promise.all(guildIds.map((g) => buildGuild(g, userId))),
    prisma.channel.findMany({
      where: { type: { in: ["dm", "group_dm"] }, recipients: { some: { userId, closed: false } } },
      include: channelInclude,
    }),
    prisma.relationship.findMany({ where: { userId } }),
    prisma.readState.findMany({ where: { userId } }),
    listNotificationSettings(userId),
  ]);
  const guilds = guildsRaw.filter((g): g is GuildDTO => !!g);

  const userIds = new Set<string>([userId]);
  for (const g of guilds) for (const m of g.members) userIds.add(m.userId);
  for (const c of privateRows) for (const r of c.recipients) userIds.add(r.userId);
  for (const r of rels) userIds.add(r.targetId);
  const users = await prisma.user.findMany({ where: { id: { in: [...userIds] } }, select: userSelect });

  return {
    user: toSelf(me),
    sessionId: sid,
    settings: jsonParse<Record<string, unknown>>(me.settings, {}),
    guilds,
    users: users.map(toUser),
    privateChannels: privateRows.map(toChannel),
    relationships: rels.map((r) => ({ userId: r.targetId, type: r.type as RelationshipTypeValue, since: r.since.toISOString() })),
    readStates: readStates.map((r) => ({ channelId: r.channelId, lastReadId: r.lastReadId, mentionCount: r.mentionCount })),
    presences: [...userIds].map((u) => presence.get(u)).filter((p) => p.status !== "offline"),
    voiceStates: voice.statesVisibleTo(userId),
    calls: voice.callsFor(userId),
    notificationSettings,
    server: serverInfo(),
  };
}
