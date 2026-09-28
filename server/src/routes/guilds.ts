import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  Permission,
  banSchema,
  channelCreateSchema,
  channelPositionsSchema,
  emojiNameSchema,
  guildCreateSchema,
  guildUpdateSchema,
  inviteCreateSchema,
  memberUpdateSchema,
  roleCreateSchema,
  rolePositionsSchema,
  roleUpdateSchema,
  zId,
} from "@nova/shared";
import { authenticate } from "../lib/auth";
import { badRequest, forbidden, notFound, parse } from "../lib/errors";
import { processImage, publicUrl, readLimited } from "../lib/files";
import { cache } from "../state/cache";
import { voice } from "../state/voice";
import * as guilds from "../services/guilds";
import { createChannel, setChannelPositions } from "../services/channels";
import { createInvite, listInvites } from "../services/invites";
import { listAudit, audit } from "../services/audit";
import { searchMessages } from "../services/messages";
import { ackGuild } from "../services/readstates";

const gid = z.object({ guildId: zId });

export async function guildRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  app.post("/", { config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } }, async (req, reply) => {
    const g = await guilds.createGuild(req.auth.userId, parse(guildCreateSchema, req.body));
    return reply.code(201).send(g);
  });

  app.get("/:guildId", async (req) => {
    const { guildId } = parse(gid, req.params);
    if (!cache.isMember(guildId, req.auth.userId)) throw notFound("unknown_guild");
    return guilds.buildGuildCreate(guildId, req.auth.userId);
  });

  app.patch("/:guildId", async (req) => {
    const { guildId } = parse(gid, req.params);
    return guilds.updateGuild(req.auth.userId, guildId, parse(guildUpdateSchema, req.body));
  });

  app.delete("/:guildId", async (req, reply) => {
    const { guildId } = parse(gid, req.params);
    await guilds.deleteGuild(req.auth.userId, guildId);
    return reply.code(204).send();
  });

  app.post("/:guildId/transfer", async (req) => {
    const { guildId } = parse(gid, req.params);
    const { userId } = parse(z.object({ userId: zId }), req.body);
    await guilds.transferOwnership(req.auth.userId, guildId, userId);
    return { ok: true };
  });

  // ── channels ──
  app.post("/:guildId/channels", async (req, reply) => {
    const { guildId } = parse(gid, req.params);
    return reply.code(201).send(await createChannel(req.auth.userId, guildId, parse(channelCreateSchema, req.body)));
  });
  app.patch("/:guildId/channels", async (req) => {
    const { guildId } = parse(gid, req.params);
    await setChannelPositions(req.auth.userId, guildId, parse(channelPositionsSchema, req.body));
    return { ok: true };
  });

  // ── members ──
  app.patch("/:guildId/members/:userId", async (req) => {
    const { guildId, userId } = parse(z.object({ guildId: zId, userId: z.union([zId, z.literal("@me")]) }), req.params);
    const target = userId === "@me" ? req.auth.userId : userId;
    return guilds.updateMember(req.auth.userId, guildId, target, parse(memberUpdateSchema, req.body));
  });
  app.delete("/:guildId/members/:userId", async (req, reply) => {
    const { guildId, userId } = parse(z.object({ guildId: zId, userId: zId }), req.params);
    const { reason } = parse(z.object({ reason: z.string().max(512).optional() }), req.query);
    await guilds.kickMember(req.auth.userId, guildId, userId, reason);
    return reply.code(204).send();
  });

  // Voice moderation: server mute/deafen, move, disconnect.
  app.patch("/:guildId/voice/:userId", async (req) => {
    const { guildId, userId } = parse(z.object({ guildId: zId, userId: zId }), req.params);
    const body = parse(z.object({ mute: z.boolean().optional(), deaf: z.boolean().optional(), channelId: zId.nullable().optional() }), req.body);
    const actor = req.auth.userId;
    guilds.requireMember(guildId, actor);
    if (!cache.isMember(guildId, userId)) throw notFound("unknown_member");
    if (actor !== userId && !cache.outranks(guildId, actor, userId) && (body.mute !== undefined || body.deaf !== undefined)) throw forbidden("hierarchy");
    if (body.mute !== undefined && !cache.hasGuildPerm(guildId, actor, Permission.MUTE_MEMBERS)) throw forbidden("missing_permissions");
    if (body.deaf !== undefined && !cache.hasGuildPerm(guildId, actor, Permission.DEAFEN_MEMBERS)) throw forbidden("missing_permissions");
    if (body.mute !== undefined || body.deaf !== undefined) await voice.setServerFlags(guildId, userId, { mute: body.mute, deaf: body.deaf });
    if (body.channelId !== undefined) {
      const state = voice.get(userId);
      if (!state || state.guildId !== guildId) throw badRequest("not_in_voice");
      if (!cache.hasGuildPerm(guildId, actor, Permission.MOVE_MEMBERS)) throw forbidden("missing_permissions");
      if (body.channelId) {
        const c = cache.channel(body.channelId);
        if (!c || c.guildId !== guildId || c.type !== "voice") throw badRequest("invalid_channel");
        if (!cache.can(body.channelId, userId, Permission.CONNECT)) throw forbidden("target_cannot_connect");
      }
      await voice.move(userId, body.channelId);
      await audit(guildId, actor, body.channelId ? "member_voice_move" : "member_voice_kick", userId, { channelId: body.channelId });
    }
    return { ok: true };
  });

  // ── bans ──
  app.get("/:guildId/bans", async (req) => {
    const { guildId } = parse(gid, req.params);
    return guilds.listBans(req.auth.userId, guildId);
  });
  app.put("/:guildId/bans/:userId", async (req, reply) => {
    const { guildId, userId } = parse(z.object({ guildId: zId, userId: zId }), req.params);
    const body = parse(banSchema, req.body ?? {});
    await guilds.banMember(req.auth.userId, guildId, userId, body.reason, body.deleteMessageSeconds);
    return reply.code(204).send();
  });
  app.delete("/:guildId/bans/:userId", async (req, reply) => {
    const { guildId, userId } = parse(z.object({ guildId: zId, userId: zId }), req.params);
    await guilds.unbanMember(req.auth.userId, guildId, userId);
    return reply.code(204).send();
  });

  // ── roles ──
  app.post("/:guildId/roles", async (req, reply) => {
    const { guildId } = parse(gid, req.params);
    return reply.code(201).send(await guilds.createRole(req.auth.userId, guildId, parse(roleCreateSchema, req.body ?? {})));
  });
  app.patch("/:guildId/roles", async (req) => {
    const { guildId } = parse(gid, req.params);
    await guilds.setRolePositions(req.auth.userId, guildId, parse(rolePositionsSchema, req.body));
    await voice.refreshRights(guildId);
    return { ok: true };
  });
  app.patch("/:guildId/roles/:roleId", async (req) => {
    const { guildId, roleId } = parse(z.object({ guildId: zId, roleId: zId }), req.params);
    const r = await guilds.updateRole(req.auth.userId, guildId, roleId, parse(roleUpdateSchema, req.body));
    await voice.refreshRights(guildId);
    return r;
  });
  app.delete("/:guildId/roles/:roleId", async (req, reply) => {
    const { guildId, roleId } = parse(z.object({ guildId: zId, roleId: zId }), req.params);
    await guilds.deleteRole(req.auth.userId, guildId, roleId);
    await voice.refreshRights(guildId);
    return reply.code(204).send();
  });

  // ── emoji ──
  app.post("/:guildId/emojis", async (req, reply) => {
    const { guildId } = parse(gid, req.params);
    guilds.requireGuildPerm(guildId, req.auth.userId, Permission.MANAGE_EMOJIS);
    const { name } = parse(z.object({ name: emojiNameSchema }), req.query);
    const file = await req.file();
    if (!file) throw badRequest("no_file");
    const buf = await readLimited(file.file, 2 * 1024 * 1024);
    const { rel, animated } = await processImage(buf, "emoji");
    return reply.code(201).send(await guilds.createEmoji(req.auth.userId, guildId, name, publicUrl(rel), animated));
  });
  app.patch("/:guildId/emojis/:emojiId", async (req) => {
    const { guildId, emojiId } = parse(z.object({ guildId: zId, emojiId: zId }), req.params);
    const { name } = parse(z.object({ name: emojiNameSchema }), req.body);
    await guilds.renameEmoji(req.auth.userId, guildId, emojiId, name);
    return { ok: true };
  });
  app.delete("/:guildId/emojis/:emojiId", async (req, reply) => {
    const { guildId, emojiId } = parse(z.object({ guildId: zId, emojiId: zId }), req.params);
    await guilds.deleteEmoji(req.auth.userId, guildId, emojiId);
    return reply.code(204).send();
  });

  // ── invites / audit / search / ack ──
  app.get("/:guildId/invites", async (req) => {
    const { guildId } = parse(gid, req.params);
    return listInvites(req.auth.userId, guildId);
  });
  app.post("/:guildId/invites", async (req, reply) => {
    const { guildId } = parse(gid, req.params);
    return reply.code(201).send(await createInvite(req.auth.userId, guildId, parse(inviteCreateSchema, req.body ?? {})));
  });

  app.get("/:guildId/audit-log", async (req) => {
    const { guildId } = parse(gid, req.params);
    guilds.requireGuildPerm(guildId, req.auth.userId, Permission.VIEW_AUDIT_LOG);
    const { before, limit } = parse(z.object({ before: zId.optional(), limit: z.coerce.number().int().optional() }), req.query);
    return listAudit(guildId, before, limit);
  });

  app.get("/:guildId/messages/search", async (req) => {
    const { guildId } = parse(gid, req.params);
    const q = parse(searchQuery, req.query);
    return searchMessages(req.auth.userId, { guildId }, { ...q, has: q.has ? q.has.split(",") : undefined });
  });

  app.post("/:guildId/ack", async (req) => {
    const { guildId } = parse(gid, req.params);
    await ackGuild(req.auth.userId, guildId);
    return { ok: true };
  });
}

export const searchQuery = z.object({
  content: z.string().max(200).optional(),
  authorId: zId.optional(),
  channelId: zId.optional(),
  mentions: zId.optional(),
  has: z.string().max(100).optional(),
  before: zId.optional(),
  after: zId.optional(),
  pinned: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  offset: z.coerce.number().int().min(0).max(5000).optional(),
});
