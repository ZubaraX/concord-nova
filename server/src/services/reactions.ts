import { LIMITS, Permission, hasPerm, parseReactionKey } from "@nova/shared";
import { prisma } from "../db";
import { badRequest, forbidden, notFound } from "../lib/errors";
import { limits } from "../lib/rate";
import { cache } from "../state/cache";
import { toChannel } from "../gateway/io";
import { requireView } from "./messages";

// A single emoji (with optional skin tone / ZWJ sequence / variation selector),
// a flag, or a keycap. Loose on purpose — new emoji keep appearing.
const UNICODE_EMOJI_RE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]️?⃣)[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Emoji_Component}‍️⃣\p{Regional_Indicator}]*$/u;

async function validateEmoji(userId: string, channelId: string, key: string) {
  const parsed = parseReactionKey(key);
  if (!parsed.id) {
    if (key.length > 64 || !UNICODE_EMOJI_RE.test(key)) throw badRequest("invalid_emoji");
    return;
  }
  const emoji = await prisma.emoji.findUnique({ where: { id: parsed.id }, select: { guildId: true, name: true } });
  if (!emoji || emoji.name !== parsed.name) throw badRequest("unknown_emoji");
  const here = cache.guildOf(channelId);
  if (emoji.guildId !== here) {
    if (!cache.isMember(emoji.guildId, userId)) throw forbidden("emoji_unavailable");
    if (!cache.can(channelId, userId, Permission.USE_EXTERNAL_EMOJIS)) throw forbidden("missing_permissions");
  }
}

async function messageIn(channelId: string, messageId: string) {
  const m = await prisma.message.findUnique({ where: { id: messageId }, select: { channelId: true } });
  if (!m || m.channelId !== channelId) throw notFound("unknown_message");
}

export async function addReaction(userId: string, channelId: string, messageId: string, emoji: string) {
  const bits = requireView(userId, channelId, true);
  limits.reactions.consume(userId);
  await messageIn(channelId, messageId);
  await validateEmoji(userId, channelId, emoji);
  const existing = await prisma.reaction.findMany({ where: { messageId }, select: { emoji: true }, distinct: ["emoji"] });
  const isNew = !existing.some((e) => e.emoji === emoji);
  if (isNew) {
    if (!hasPerm(bits, Permission.ADD_REACTIONS)) throw forbidden("missing_permissions");
    if (existing.length >= LIMITS.reactionsPerMessage) throw badRequest("too_many_reactions");
  }
  try {
    await prisma.reaction.create({ data: { messageId, userId, emoji } });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return; // already reacted
    throw e;
  }
  toChannel(channelId, "MESSAGE_REACTION_ADD", { channelId, messageId, emoji, userId });
}

export async function removeReaction(actorId: string, channelId: string, messageId: string, emoji: string, targetUserId: string) {
  const bits = requireView(actorId, channelId);
  if (targetUserId !== actorId && !(cache.guildOf(channelId) && hasPerm(bits, Permission.MANAGE_MESSAGES))) throw forbidden("missing_permissions");
  const res = await prisma.reaction.deleteMany({ where: { messageId, userId: targetUserId, emoji } });
  if (res.count) toChannel(channelId, "MESSAGE_REACTION_REMOVE", { channelId, messageId, emoji, userId: targetUserId });
}

export async function removeAllOfEmoji(actorId: string, channelId: string, messageId: string, emoji: string) {
  const bits = requireView(actorId, channelId);
  if (!(cache.guildOf(channelId) && hasPerm(bits, Permission.MANAGE_MESSAGES))) throw forbidden("missing_permissions");
  const res = await prisma.reaction.deleteMany({ where: { messageId, emoji } });
  if (res.count) toChannel(channelId, "MESSAGE_REACTION_REMOVE_EMOJI", { channelId, messageId, emoji });
}

export async function reactionUsers(userId: string, channelId: string, messageId: string, emoji: string) {
  requireView(userId, channelId, true);
  const rows = await prisma.reaction.findMany({ where: { messageId, emoji }, orderBy: { createdAt: "asc" }, take: 100, select: { userId: true } });
  return rows.map((r) => r.userId);
}
