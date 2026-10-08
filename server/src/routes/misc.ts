// Invites (public preview + accept), the Android push stream, and the apps' diagnostic logs.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, signPushToken, verifyPushToken } from "../lib/auth";
import { parse, unauthorized } from "../lib/errors";
import { acceptInvite, deleteInvite, getInvite } from "../services/invites";
import { addPushStream } from "../services/push";
import { appendDiag } from "../services/diag";
import { limits } from "../lib/rate";
import { voice } from "../state/voice";

const codeParam = z.object({ code: z.string().regex(/^[A-Za-z0-9-]{2,32}$/) });

export async function inviteRoutes(app: FastifyInstance) {
  app.get("/:code", async (req) => getInvite(parse(codeParam, req.params).code));
  app.post("/:code", { preHandler: authenticate }, async (req) => acceptInvite(req.auth.userId, parse(codeParam, req.params).code));
  app.delete("/:code", { preHandler: authenticate }, async (req, reply) => {
    await deleteInvite(req.auth.userId, parse(codeParam, req.params).code);
    return reply.code(204).send();
  });
}

/** The apps send what happened in calls and connections, for the admins to look into problems. */
export async function diagRoutes(app: FastifyInstance) {
  app.post("/", { preHandler: authenticate, bodyLimit: 512 * 1024 }, async (req) => {
    limits.diag.consume(req.auth.userId);
    // Too long is cut rather than refused: a refused log is a lost one (1.7.3's Windows app sent a 171-character name).
    const cut = (n: number) => z.string().transform((s) => s.slice(0, n));
    const body = parse(z.object({ client: cut(300), lines: z.array(cut(2000)).min(1).max(1000) }), req.body);
    await appendDiag(req.auth.userId, body.client, body.lines);
    return { ok: true };
  });
}

export async function pushRoutes(app: FastifyInstance) {
  // The Android service can't refresh short-lived access tokens in the
  // background; it gets a long-lived token that is ONLY valid for this stream
  // and dies with the session.
  app.post("/token", { preHandler: authenticate }, async (req) => ({ token: await signPushToken(req.auth.userId, req.auth.sid) }));

  // "Decline" from the Android call notification — the WebView may be asleep,
  // so the service authenticates with its push token.
  app.post("/decline", { config: { rateLimit: { max: 30, timeWindow: 60_000 } } }, async (req, reply) => {
    const { token, channelId } = parse(z.object({ token: z.string().min(10).max(2000), channelId: z.string().max(40) }), req.body);
    let ctx;
    try {
      ctx = await verifyPushToken(token);
    } catch {
      throw unauthorized("invalid_token");
    }
    voice.decline(ctx.userId, channelId);
    return reply.code(204).send();
  });

  app.get("/stream", async (req, reply) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(2000) }), req.query);
    let ctx;
    try {
      ctx = await verifyPushToken(token);
    } catch {
      throw unauthorized("invalid_token");
    }
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
    const remove = addPushStream(ctx.userId, ctx.sid, res);
    const hb = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        /* closed */
      }
    }, 25_000);
    const done = () => {
      clearInterval(hb);
      remove();
    };
    req.raw.on("close", done);
    res.on("close", done);
  });
}
