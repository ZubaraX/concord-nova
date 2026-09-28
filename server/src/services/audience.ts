// Who should hear about changes to a user (profile, presence): members of
// their guilds, their friends / pending requests, optionally DM partners.
import { RelationshipType } from "@nova/shared";
import { prisma } from "../db";
import { cache } from "../state/cache";
import { presence } from "../state/presence";
import { dispatch, rooms, toUser } from "../gateway/io";
import { toSelf, toUser as toUserDto, userSelect } from "./serialize";

export async function audienceRooms(userId: string, opts: { dms?: boolean } = {}): Promise<string[]> {
  const out = new Set<string>();
  for (const gid of cache.userGuildIds(userId)) out.add(rooms.guild(gid));
  const rels = await prisma.relationship.findMany({
    where: { userId, type: { not: RelationshipType.BLOCKED } },
    select: { targetId: true },
  });
  for (const r of rels) out.add(rooms.user(r.targetId));
  if (opts.dms) {
    for (const cid of cache.userPrivateIds(userId)) for (const u of cache.privates.get(cid)?.recipients ?? []) out.add(rooms.user(u));
  }
  out.add(rooms.user(userId));
  return [...out];
}

export async function broadcastPresence(userId: string) {
  const dto = presence.diff(userId);
  if (!dto) return;
  dispatch(await audienceRooms(userId), "PRESENCE_UPDATE", dto);
}

/** Push fresh profile data to everyone who displays this user. */
export async function broadcastUserUpdate(userId: string) {
  const full = await prisma.user.findUnique({ where: { id: userId } });
  if (!full) return;
  toUser(userId, "SELF_UPDATE", toSelf(full));
  const pub = await prisma.user.findUnique({ where: { id: userId }, select: userSelect });
  if (pub) dispatch(await audienceRooms(userId, { dms: true }), "USER_UPDATE", toUserDto(pub));
}
