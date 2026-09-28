import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Permission, RelationshipType, zId } from "@nova/shared";
import { prisma } from "../db";
import { config, voiceEnabled } from "../config";
import { authenticate } from "../lib/auth";
import { ApiError, badRequest, forbidden, notFound, parse } from "../lib/errors";
import { limits } from "../lib/rate";
import { cache } from "../state/cache";
import { voice } from "../state/voice";
import * as lk from "../voice/livekit";

export async function voiceRoutes(app: FastifyInstance) {
  // LiveKit posts webhooks as application/webhook+json; the signature covers
  // the raw body, so keep it as a string.
  app.addContentTypeParser("application/webhook+json", { parseAs: "string" }, (_req, body, done) => done(null, body));

  app.post("/join", { preHandler: authenticate }, async (req) => {
    const userId = req.auth.userId;
    const input = parse(z.object({ channelId: zId, selfMute: z.boolean().default(false), selfDeaf: z.boolean().default(false) }), req.body);
    if (!voiceEnabled()) throw new ApiError(503, "voice_unavailable");
    limits.voiceJoin.consume(userId);
    const { channelId } = input;

    const priv = cache.privates.get(channelId);
    if (priv) {
      if (!priv.recipients.has(userId)) throw notFound("unknown_channel");
      if (priv.type === "dm") {
        const other = [...priv.recipients].find((u) => u !== userId);
        if (other) {
          const blocked = await prisma.relationship.count({
            where: { type: RelationshipType.BLOCKED, OR: [{ userId, targetId: other }, { userId: other, targetId: userId }] },
          });
          if (blocked) throw forbidden("blocked");
        }
      }
    } else {
      const c = cache.channel(channelId);
      if (!c || c.type !== "voice") throw badRequest("not_voice_channel");
      const bits = cache.channelPerms(channelId, userId);
      if (!(bits & Permission.VIEW_CHANNEL)) throw notFound("unknown_channel");
      if (!(bits & Permission.CONNECT)) throw forbidden("cannot_connect");
      const row = await prisma.channel.findUnique({ where: { id: channelId }, select: { userLimit: true } });
      const current = voice.get(userId)?.channelId;
      if (row?.userLimit && current !== channelId && voice.countInChannel(channelId) >= row.userLimit && !(bits & Permission.MOVE_MEMBERS)) {
        throw forbidden("channel_full");
      }
    }

    // One voice connection per account: leaving the old room from any device.
    const prev = voice.get(userId);
    if (prev?.channelId && prev.channelId !== channelId) await lk.removeParticipant(prev.channelId, userId);

    voice.setPendingSelf(userId, { selfMute: input.selfMute, selfDeaf: input.selfDeaf });
    const { rights, canSubscribe } = voice.rightsFor(userId, channelId);
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { displayName: true, username: true, avatar: true } });
    const token = await lk.joinToken({
      userId,
      name: user?.displayName || user?.username || userId,
      avatar: user?.avatar ?? null,
      channelId,
      rights,
      canSubscribe,
    });
    return { url: config.livekit.publicUrl || null, token, channelId, rights, canSubscribe };
  });

  app.post("/webhook", async (req, reply) => {
    const receiver = lk.webhookReceiver();
    if (!receiver) return reply.code(404).send();
    let ev;
    try {
      ev = await receiver.receive(typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}), req.headers.authorization);
    } catch {
      return reply.code(401).send({ error: { code: "bad_signature" } });
    }
    const channelId = lk.channelFromRoom(ev.room?.name);
    const p = ev.participant;
    if (channelId) {
      switch (ev.event) {
        case "participant_joined":
          if (p?.identity) await voice.onJoin(p.identity, channelId, p.sid, Number(p.joinedAt) * 1000 || undefined);
          break;
        case "participant_left":
        case "participant_connection_aborted":
          if (p?.identity) await voice.onLeave(p.identity, channelId, p.sid);
          break;
        case "room_finished":
          for (const uid of voice.usersInChannel(channelId)) await voice.onLeave(uid, channelId);
          break;
      }
    }
    return { ok: true };
  });
}
