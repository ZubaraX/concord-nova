// Friends, requests and blocks. Two rows per pair (one per side) so each user
// sees their own view: friend / incoming / outgoing / blocked.
import { RelationshipType, USERNAME_RE, type RelationshipDTO, type RelationshipTypeValue } from "@nova/shared";
import { prisma } from "../db";
import { badRequest, conflict, notFound } from "../lib/errors";
import { limits } from "../lib/rate";
import { presence } from "../state/presence";
import { toUser } from "../gateway/io";
import { toUser as toUserDto, userSelect } from "./serialize";

async function emitAdd(userId: string, targetId: string, type: RelationshipTypeValue, since: Date) {
  const target = await prisma.user.findUnique({ where: { id: targetId }, select: userSelect });
  if (!target) return;
  toUser(userId, "RELATIONSHIP_ADD", { userId: targetId, type, since: since.toISOString(), user: toUserDto(target) });
}

async function setRel(userId: string, targetId: string, type: RelationshipTypeValue) {
  const row = await prisma.relationship.upsert({
    where: { userId_targetId: { userId, targetId } },
    create: { userId, targetId, type },
    update: { type, since: new Date() },
  });
  await emitAdd(userId, targetId, type, row.since);
}

async function dropRel(userId: string, targetId: string) {
  const r = await prisma.relationship.deleteMany({ where: { userId, targetId } });
  if (r.count) toUser(userId, "RELATIONSHIP_REMOVE", { userId: targetId });
}

const get = (userId: string, targetId: string) => prisma.relationship.findUnique({ where: { userId_targetId: { userId, targetId } } });

function sharePresence(a: string, b: string) {
  const pa = presence.get(a);
  const pb = presence.get(b);
  if (pa.status !== "offline") toUser(b, "PRESENCE_UPDATE", pa);
  if (pb.status !== "offline") toUser(a, "PRESENCE_UPDATE", pb);
}

export async function listRelationships(userId: string): Promise<RelationshipDTO[]> {
  const rows = await prisma.relationship.findMany({ where: { userId } });
  return rows.map((r) => ({ userId: r.targetId, type: r.type as RelationshipTypeValue, since: r.since.toISOString() }));
}

export async function requestFriend(userId: string, targetId: string) {
  if (userId === targetId) throw badRequest("cannot_friend_self");
  limits.friendRequests.consume(userId);
  const [mine, theirs] = await Promise.all([get(userId, targetId), get(targetId, userId)]);
  if (theirs?.type === RelationshipType.BLOCKED) throw badRequest("cannot_add"); // don't reveal the block
  if (mine?.type === RelationshipType.BLOCKED) throw badRequest("unblock_first");
  if (mine?.type === RelationshipType.FRIEND) throw conflict("already_friends");
  if (mine?.type === RelationshipType.OUTGOING) throw conflict("already_requested");
  if (mine?.type === RelationshipType.INCOMING) return acceptFriend(userId, targetId);
  await setRel(userId, targetId, RelationshipType.OUTGOING);
  await setRel(targetId, userId, RelationshipType.INCOMING);
}

const fold = (s: string) => s.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("ru").replace(/ё/g, "е");

/**
 * Who does "add friend" mean? People type what they remember: "@name", the
 * old Concord "Name#1234", or the display name (after the move from Concord
 * that holds the old name when the handle had to change). Username first;
 * display name only when exactly one account has it.
 */
export async function resolveUserQuery(query: string): Promise<string> {
  const raw = query.trim().replace(/^@/, "").replace(/#\d{1,6}$/, "");
  const handle = raw.toLowerCase();
  if (USERNAME_RE.test(handle)) {
    const byName = await prisma.user.findUnique({ where: { username: handle }, select: { id: true } });
    if (byName) return byName.id;
  }
  const wanted = fold(raw);
  if (!wanted) throw notFound("unknown_user");
  // SQLite's lower() only folds ASCII, so compare in JS (instances are small).
  const named = await prisma.user.findMany({ where: { displayName: { not: null } }, select: { id: true, displayName: true }, take: 20_000 });
  const hits = named.filter((u) => fold(u.displayName!) === wanted);
  if (hits.length === 1) return hits[0].id;
  if (hits.length > 1) throw conflict("ambiguous_user");
  throw notFound("unknown_user");
}

export async function requestFriendByUsername(userId: string, username: string) {
  const targetId = await resolveUserQuery(username);
  await requestFriend(userId, targetId);
  return targetId;
}

export async function acceptFriend(userId: string, targetId: string) {
  const mine = await get(userId, targetId);
  if (mine?.type !== RelationshipType.INCOMING) throw badRequest("no_request");
  await setRel(userId, targetId, RelationshipType.FRIEND);
  await setRel(targetId, userId, RelationshipType.FRIEND);
  sharePresence(userId, targetId);
}

export async function removeRelationship(userId: string, targetId: string) {
  const mine = await get(userId, targetId);
  if (!mine) throw notFound("unknown_relationship");
  if (mine.type === RelationshipType.BLOCKED) return dropRel(userId, targetId);
  await dropRel(userId, targetId);
  const theirs = await get(targetId, userId);
  if (theirs && theirs.type !== RelationshipType.BLOCKED) await dropRel(targetId, userId);
}

export async function blockUser(userId: string, targetId: string) {
  if (userId === targetId) throw badRequest("cannot_block_self");
  const exists = await prisma.user.count({ where: { id: targetId } });
  if (!exists) throw notFound("unknown_user");
  const theirs = await get(targetId, userId);
  if (theirs && theirs.type !== RelationshipType.BLOCKED) await dropRel(targetId, userId);
  await setRel(userId, targetId, RelationshipType.BLOCKED);
}
