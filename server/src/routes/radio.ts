// The radio of a voice channel: only people in that call may change it.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Permission, isMusicServiceLink, radioItemCreateSchema, radioLinkCreateSchema, radioSkipSchema, zId } from "@nova/shared";
import { authenticate } from "../lib/auth";
import { badRequest, forbidden, parse } from "../lib/errors";
import { cache } from "../state/cache";
import { radio } from "../state/radio";
import { voice } from "../state/voice";

const params = z.object({ id: zId });
const itemParams = z.object({ id: zId, itemId: zId });

function inCall(userId: string, channelId: string) {
  if (voice.get(userId)?.channelId !== channelId) throw forbidden("not_in_call");
}

/** Playing to the channel is speaking in it: a server mute or no "speak" covers the radio too. */
function maySpeak(userId: string, channelId: string) {
  inCall(userId, channelId);
  if (!voice.rightsFor(userId, channelId).rights.mic) throw forbidden("muted");
}

export async function radioRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  app.get("/api/channels/:id/radio", async (req) => {
    const { id } = parse(params, req.params);
    if (!cache.canView(id, req.auth.userId)) throw forbidden("missing_access");
    return radio.state(id);
  });
  app.post("/api/channels/:id/radio/items", async (req) => {
    const { id } = parse(params, req.params);
    maySpeak(req.auth.userId, id);
    const input = parse(radioItemCreateSchema, req.body);
    if (input.url && isMusicServiceLink(input.url)) throw badRequest("music_service_link");
    return radio.add(id, req.auth.userId, input);
  });
  app.post("/api/channels/:id/radio/links", async (req) => {
    const { id } = parse(params, req.params);
    inCall(req.auth.userId, id);
    const input = parse(radioLinkCreateSchema, req.body);
    const service = isMusicServiceLink(input.url);
    if (!service) throw badRequest("not_a_music_service_link");
    return radio.addLink(id, req.auth.userId, input, service);
  });
  app.delete("/api/channels/:id/radio/items/:itemId", async (req) => {
    const { id, itemId } = parse(itemParams, req.params);
    inCall(req.auth.userId, id);
    const moderator = !!cache.guildOf(id) && cache.can(id, req.auth.userId, Permission.MOVE_MEMBERS);
    radio.remove(id, req.auth.userId, itemId, moderator);
    return radio.state(id);
  });
  app.post("/api/channels/:id/radio/skip", async (req) => {
    const { id } = parse(params, req.params);
    maySpeak(req.auth.userId, id);
    radio.skip(id, parse(radioSkipSchema, req.body).itemId);
    return radio.state(id);
  });
  for (const action of ["pause", "resume"] as const)
    app.post(`/api/channels/:id/radio/${action}`, async (req) => {
      const { id } = parse(params, req.params);
      maySpeak(req.auth.userId, id);
      radio[action](id);
      return radio.state(id);
    });
}
