import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  Permission,
  ackSchema,
  channelUpdateSchema,
  inviteCreateSchema,
  messageCreateSchema,
  messageEditSchema,
  pollVoteSchema,
  scheduledCreateSchema,
  threadCreateSchema,
  ulid,
  zId,
} from "@nova/shared";
import { prisma } from "../db";
import { authenticate } from "../lib/auth";
import { badRequest, forbidden, notFound, parse } from "../lib/errors";
import { limits } from "../lib/rate";
import { cache } from "../state/cache";
import { voice } from "../state/voice";
import { toChannel as emitToChannel } from "../gateway/io";
import { channelInclude, toChannel } from "../services/serialize";
import * as channels from "../services/channels";
import * as messages from "../services/messages";
import * as reactions from "../services/reactions";
import { ackChannel } from "../services/readstates";
import { createInvite } from "../services/invites";
import { searchQuery } from "./guilds";

const cid = z.object({ channelId: zId });
const cmid = z.object({ channelId: zId, messageId: zId });
const reactionParams = z.object({ channelId: zId, messageId: zId, emoji: z.string().min(1).max(100) });

export async function channelRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  app.get("/:channelId", async (req) => {
    const { channelId } = parse(cid, req.params);
    if (!cache.canView(channelId, req.auth.userId)) throw notFound("unknown_channel");
    const row = await prisma.channel.findUnique({ where: { id: channelId }, include: channelInclude });
    if (!row) throw notFound("unknown_channel");
    return toChannel(row);
  });

  app.patch("/:channelId", async (req) => {
    const { channelId } = parse(cid, req.params);
    const dto = await channels.updateChannel(req.auth.userId, channelId, parse(channelUpdateSchema, req.body));
    const gid = cache.guildOf(channelId);
    if (gid) await voice.refreshRights(gid);
    return dto;
  });

  app.delete("/:channelId", async (req, reply) => {
    const { channelId } = parse(cid, req.params);
    await channels.deleteChannel(req.auth.userId, channelId);
    return reply.code(204).send();
  });

  // ── messages ──
  app.get("/:channelId/messages", async (req) => {
    const { channelId } = parse(cid, req.params);
    const q = parse(
      z.object({ before: zId.optional(), after: zId.optional(), around: zId.optional(), limit: z.coerce.number().int().min(1).max(100).optional() }),
      req.query
    );
    return messages.getMessages(req.auth.userId, channelId, q);
  });

  app.post("/:channelId/messages", async (req, reply) => {
    const { channelId } = parse(cid, req.params);
    const input = parse(messageCreateSchema, req.body);
    return reply.code(201).send(await messages.createMessage(req.auth.userId, channelId, input));
  });

  app.patch("/:channelId/messages/:messageId", async (req) => {
    const { messageId } = parse(cmid, req.params);
    const body = parse(messageEditSchema, req.body);
    return messages.editMessage(req.auth.userId, messageId, body.content, body.suppressEmbeds);
  });

  app.delete("/:channelId/messages/:messageId", async (req, reply) => {
    const { messageId } = parse(cmid, req.params);
    const { reason } = parse(z.object({ reason: z.string().max(512).optional() }), req.query);
    await messages.deleteMessage(req.auth.userId, messageId, reason);
    return reply.code(204).send();
  });

  app.post("/:channelId/typing", async (req, reply) => {
    const { channelId } = parse(cid, req.params);
    const userId = req.auth.userId;
    if (limits.typing.take(`${userId}:${channelId}`) === 0 && cache.can(channelId, userId, Permission.SEND_MESSAGES)) {
      emitToChannel(channelId, "TYPING_START", { channelId, userId, timestamp: Date.now() }, userId);
    }
    return reply.code(204).send();
  });

  app.get("/:channelId/messages/search", async (req) => {
    const { channelId } = parse(cid, req.params);
    const q = parse(searchQuery, req.query);
    return messages.searchMessages(req.auth.userId, { channelId }, { ...q, has: q.has ? q.has.split(",") : undefined });
  });

  // ── reactions ──
  app.put("/:channelId/messages/:messageId/reactions/:emoji/@me", async (req, reply) => {
    const p = parse(reactionParams, req.params);
    await reactions.addReaction(req.auth.userId, p.channelId, p.messageId, decodeURIComponent(p.emoji));
    return reply.code(204).send();
  });
  app.delete("/:channelId/messages/:messageId/reactions/:emoji/@me", async (req, reply) => {
    const p = parse(reactionParams, req.params);
    await reactions.removeReaction(req.auth.userId, p.channelId, p.messageId, decodeURIComponent(p.emoji), req.auth.userId);
    return reply.code(204).send();
  });
  app.delete("/:channelId/messages/:messageId/reactions/:emoji/:userId", async (req, reply) => {
    const p = parse(reactionParams.extend({ userId: zId }), req.params);
    await reactions.removeReaction(req.auth.userId, p.channelId, p.messageId, decodeURIComponent(p.emoji), p.userId);
    return reply.code(204).send();
  });
  app.delete("/:channelId/messages/:messageId/reactions/:emoji", async (req, reply) => {
    const p = parse(reactionParams, req.params);
    await reactions.removeAllOfEmoji(req.auth.userId, p.channelId, p.messageId, decodeURIComponent(p.emoji));
    return reply.code(204).send();
  });
  app.get("/:channelId/messages/:messageId/reactions/:emoji", async (req) => {
    const p = parse(reactionParams, req.params);
    return reactions.reactionUsers(req.auth.userId, p.channelId, p.messageId, decodeURIComponent(p.emoji));
  });

  // ── pins ──
  app.get("/:channelId/pins", async (req) => {
    const { channelId } = parse(cid, req.params);
    return messages.getPins(req.auth.userId, channelId);
  });
  app.put("/:channelId/pins/:messageId", async (req, reply) => {
    const { channelId, messageId } = parse(cmid, req.params);
    await messages.setPinned(req.auth.userId, channelId, messageId, true);
    return reply.code(204).send();
  });
  app.delete("/:channelId/pins/:messageId", async (req, reply) => {
    const { channelId, messageId } = parse(cmid, req.params);
    await messages.setPinned(req.auth.userId, channelId, messageId, false);
    return reply.code(204).send();
  });

  // ── read state ──
  app.post("/:channelId/ack", async (req) => {
    const { channelId } = parse(cid, req.params);
    const { messageId } = parse(ackSchema, req.body ?? {});
    await ackChannel(req.auth.userId, channelId, messageId ?? null);
    return { ok: true };
  });

  // ── polls ──
  app.post("/:channelId/polls/:messageId/votes", async (req, reply) => {
    const { channelId, messageId } = parse(cmid, req.params);
    const { answers } = parse(pollVoteSchema, req.body);
    await messages.votePoll(req.auth.userId, channelId, messageId, answers);
    return reply.code(204).send();
  });
  app.post("/:channelId/polls/:messageId/end", async (req, reply) => {
    const { channelId, messageId } = parse(cmid, req.params);
    await messages.endPoll(req.auth.userId, channelId, messageId);
    return reply.code(204).send();
  });

  // ── threads ──
  app.post("/:channelId/threads", async (req, reply) => {
    const { channelId } = parse(cid, req.params);
    const body = parse(threadCreateSchema, req.body);
    return reply.code(201).send(await channels.createThread(req.auth.userId, channelId, body.name, body.messageId));
  });
  app.get("/:channelId/threads", async (req) => {
    const { channelId } = parse(cid, req.params);
    const { archived } = parse(z.object({ archived: z.enum(["true", "false"]).optional() }), req.query);
    return channels.listThreads(req.auth.userId, channelId, archived === "true");
  });

  // ── group DM recipients ──
  app.put("/:channelId/recipients/:userId", async (req, reply) => {
    const { channelId, userId } = parse(z.object({ channelId: zId, userId: zId }), req.params);
    await channels.addGroupRecipient(req.auth.userId, channelId, userId);
    return reply.code(204).send();
  });
  app.delete("/:channelId/recipients/:userId", async (req, reply) => {
    const { channelId, userId } = parse(z.object({ channelId: zId, userId: zId }), req.params);
    await channels.removeGroupRecipient(req.auth.userId, channelId, userId);
    return reply.code(204).send();
  });

  // ── scheduled messages ──
  app.post("/:channelId/scheduled", async (req, reply) => {
    const { channelId } = parse(cid, req.params);
    const input = parse(scheduledCreateSchema, req.body);
    if (!cache.can(channelId, req.auth.userId, Permission.SEND_MESSAGES)) throw forbidden("cannot_send");
    const sendAt = new Date(input.sendAt);
    if (sendAt.getTime() < Date.now() + 30_000) throw badRequest("send_at_too_soon");
    if (sendAt.getTime() > Date.now() + 365 * 86_400_000) throw badRequest("send_at_too_far");
    if (!input.content.trim() && !input.attachments?.length) throw badRequest("empty_message");
    if ((await prisma.scheduledMessage.count({ where: { authorId: req.auth.userId } })) >= 100) throw badRequest("too_many_scheduled");
    if (input.attachments?.length) {
      const own = await prisma.attachment.count({ where: { id: { in: input.attachments }, uploaderId: req.auth.userId, messageId: null } });
      if (own !== input.attachments.length) throw badRequest("invalid_attachments");
    }
    const row = await prisma.scheduledMessage.create({
      data: { id: ulid(), channelId, authorId: req.auth.userId, content: input.content, attachments: JSON.stringify(input.attachments ?? []), sendAt },
    });
    return reply.code(201).send({ id: row.id, channelId, content: row.content, sendAt: row.sendAt.toISOString(), attachments: [] });
  });

  // ── DM calls ──
  app.post("/:channelId/call/ring", async (req) => {
    const { channelId } = parse(cid, req.params);
    const { recipients } = parse(z.object({ recipients: z.array(zId).max(10).optional() }), req.body ?? {});
    if (!cache.privates.get(channelId)?.recipients.has(req.auth.userId)) throw notFound("unknown_channel");
    await voice.ring(req.auth.userId, channelId, recipients);
    return { ok: true };
  });
  app.post("/:channelId/call/decline", async (req) => {
    const { channelId } = parse(cid, req.params);
    voice.decline(req.auth.userId, channelId);
    return { ok: true };
  });

  app.post("/:channelId/invites", async (req, reply) => {
    const { channelId } = parse(cid, req.params);
    const guildId = cache.guildOf(channelId);
    if (!guildId || !cache.canView(channelId, req.auth.userId)) throw notFound("unknown_channel");
    const input = parse(inviteCreateSchema, req.body ?? {});
    return reply.code(201).send(await createInvite(req.auth.userId, guildId, { ...input, channelId }));
  });
}
