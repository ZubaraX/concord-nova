import { randomBytes } from "node:crypto";
import { Permission, type ChannelType, type InviteDTO } from "@nova/shared";
import type { z } from "zod";
import type { inviteCreateSchema } from "@nova/shared";
import { prisma } from "../db";
import { ApiError, badRequest, forbidden, notFound } from "../lib/errors";
import { cache } from "../state/cache";
import { presence } from "../state/presence";
import { toUser as toUserDto, userSelect } from "./serialize";
import { audit } from "./audit";
import { addMember } from "./guilds";

const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function genCode(len = 8): string {
  const bytes = randomBytes(len);
  let s = "";
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
}

type InviteRow = Awaited<ReturnType<typeof prisma.invite.findUnique>> & object;

async function toInvite(inv: NonNullable<InviteRow>): Promise<InviteDTO> {
  const [guild, inviter, channel] = await Promise.all([
    prisma.guild.findUnique({ where: { id: inv.guildId }, select: { id: true, name: true, icon: true, banner: true, description: true } }),
    inv.inviterId ? prisma.user.findUnique({ where: { id: inv.inviterId }, select: userSelect }) : null,
    inv.channelId ? prisma.channel.findUnique({ where: { id: inv.channelId }, select: { id: true, name: true, type: true } }) : null,
  ]);
  const members = [...(cache.guild(inv.guildId)?.members.keys() ?? [])];
  return {
    code: inv.code,
    guild: {
      id: guild!.id,
      name: guild!.name,
      icon: guild!.icon,
      banner: guild!.banner,
      description: guild!.description,
      memberCount: members.length,
      onlineCount: members.filter((u) => presence.get(u).status !== "offline").length,
    },
    channel: channel ? { id: channel.id, name: channel.name, type: channel.type as ChannelType } : null,
    inviter: inviter ? toUserDto(inviter) : null,
    uses: inv.uses,
    maxUses: inv.maxUses,
    expiresAt: inv.expiresAt?.toISOString() ?? null,
    createdAt: inv.createdAt.toISOString(),
  };
}

export async function createInvite(actorId: string, guildId: string, input: z.output<typeof inviteCreateSchema>): Promise<InviteDTO> {
  if (!cache.isMember(guildId, actorId)) throw notFound("unknown_guild");
  const channelId = input.channelId ?? null;
  if (channelId) {
    const c = cache.channel(channelId);
    if (!c || c.guildId !== guildId) throw badRequest("invalid_channel");
    if (!cache.can(channelId, actorId, Permission.CREATE_INSTANT_INVITE)) throw forbidden("missing_permissions");
  } else if (!cache.hasGuildPerm(guildId, actorId, Permission.CREATE_INSTANT_INVITE)) throw forbidden("missing_permissions");
  if ((await prisma.invite.count({ where: { guildId } })) >= 1000) throw badRequest("too_many_invites");
  // Reuse an identical, still-valid invite from this user instead of piling up codes.
  const reuse = await prisma.invite.findFirst({
    where: { guildId, inviterId: actorId, channelId, maxUses: input.maxUses, ...(input.maxAge ? { expiresAt: { gt: new Date(Date.now() + input.maxAge * 1000 * 0.9) } } : { expiresAt: null }) },
  });
  if (reuse && (!reuse.maxUses || reuse.uses < reuse.maxUses)) return toInvite(reuse);
  const inv = await prisma.invite.create({
    data: {
      code: genCode(),
      guildId,
      channelId,
      inviterId: actorId,
      maxUses: input.maxUses,
      expiresAt: input.maxAge ? new Date(Date.now() + input.maxAge * 1000) : null,
    },
  });
  await audit(guildId, actorId, "invite_create", inv.code);
  return toInvite(inv);
}

function assertValid(inv: { expiresAt: Date | null; maxUses: number; uses: number }) {
  if ((inv.expiresAt && inv.expiresAt.getTime() < Date.now()) || (inv.maxUses > 0 && inv.uses >= inv.maxUses)) {
    throw new ApiError(410, "invite_expired");
  }
}

export async function getInvite(code: string): Promise<InviteDTO> {
  const inv = await prisma.invite.findUnique({ where: { code } });
  if (!inv) throw notFound("unknown_invite");
  assertValid(inv);
  return toInvite(inv);
}

/** Registration-by-invite check (REGISTRATION=invite). */
export async function isInviteUsable(code: string): Promise<boolean> {
  const inv = await prisma.invite.findUnique({ where: { code } });
  if (!inv) return false;
  try {
    assertValid(inv);
    return true;
  } catch {
    return false;
  }
}

export async function acceptInvite(userId: string, code: string): Promise<{ guildId: string; channelId: string | null; joined: boolean }> {
  const inv = await prisma.invite.findUnique({ where: { code } });
  if (!inv) throw notFound("unknown_invite");
  if (cache.isMember(inv.guildId, userId)) return { guildId: inv.guildId, channelId: inv.channelId, joined: false };
  assertValid(inv);
  // Atomic use-count bump so a 1-use invite can't be redeemed twice concurrently.
  const bumped = await prisma.invite.updateMany({
    where: { code, ...(inv.maxUses ? { uses: { lt: inv.maxUses } } : {}) },
    data: { uses: { increment: 1 } },
  });
  if (!bumped.count) throw new ApiError(410, "invite_expired");
  await addMember(inv.guildId, userId);
  return { guildId: inv.guildId, channelId: inv.channelId, joined: true };
}

export async function listInvites(actorId: string, guildId: string): Promise<InviteDTO[]> {
  if (!cache.isMember(guildId, actorId)) throw notFound("unknown_guild");
  if (!cache.hasGuildPerm(guildId, actorId, Permission.MANAGE_GUILD)) throw forbidden("missing_permissions");
  const rows = await prisma.invite.findMany({ where: { guildId }, orderBy: { createdAt: "desc" } });
  return Promise.all(rows.map(toInvite));
}

export async function deleteInvite(actorId: string, code: string) {
  const inv = await prisma.invite.findUnique({ where: { code } });
  if (!inv) throw notFound("unknown_invite");
  if (inv.inviterId !== actorId && !cache.hasGuildPerm(inv.guildId, actorId, Permission.MANAGE_GUILD)) throw forbidden("missing_permissions");
  await prisma.invite.delete({ where: { code } });
  await audit(inv.guildId, actorId, "invite_delete", code);
}
