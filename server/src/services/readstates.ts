import { prisma } from "../db";
import { notFound } from "../lib/errors";
import { cache } from "../state/cache";
import { toUser } from "../gateway/io";

/** Mark a channel read up to `messageId` (default: its newest message). Syncs to the user's other devices. */
export async function ackChannel(userId: string, channelId: string, messageId?: string | null) {
  if (!cache.canView(channelId, userId)) throw notFound("unknown_channel");
  let lastReadId = messageId ?? null;
  if (!lastReadId) {
    const ch = await prisma.channel.findUnique({ where: { id: channelId }, select: { lastMessageId: true } });
    lastReadId = ch?.lastMessageId ?? null;
  }
  await prisma.readState.upsert({
    where: { userId_channelId: { userId, channelId } },
    create: { userId, channelId, lastReadId, mentionCount: 0 },
    update: { lastReadId, mentionCount: 0 },
  });
  toUser(userId, "MESSAGE_ACK", { channelId, messageId: lastReadId, mentionCount: 0 });
}

export async function ackGuild(userId: string, guildId: string) {
  if (!cache.isMember(guildId, userId)) throw notFound("unknown_guild");
  const ids = cache.visibleChannelIds(guildId, userId);
  const channels = await prisma.channel.findMany({ where: { id: { in: ids }, lastMessageId: { not: null } }, select: { id: true, lastMessageId: true } });
  await prisma.$transaction(
    channels.map((c) =>
      prisma.readState.upsert({
        where: { userId_channelId: { userId, channelId: c.id } },
        create: { userId, channelId: c.id, lastReadId: c.lastMessageId, mentionCount: 0 },
        update: { lastReadId: c.lastMessageId, mentionCount: 0 },
      })
    )
  );
  for (const c of channels) toUser(userId, "MESSAGE_ACK", { channelId: c.id, messageId: c.lastMessageId, mentionCount: 0 });
}
