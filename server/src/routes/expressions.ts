// /api/sounds and /api/voice-presets — soundboard sounds and voice changers,
// personal or shared with a server.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MAX_SOUND_BYTES, soundCreateSchema, soundUpdateSchema, voicePresetCreateSchema, voicePresetUpdateSchema, zId } from "@nova/shared";
import { authenticate } from "../lib/auth";
import { badRequest, parse } from "../lib/errors";
import { limits } from "../lib/rate";
import * as ex from "../services/expressions";

const idParam = z.object({ id: zId });

export async function expressionRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  /** Your own sounds and presets plus those of every server you're in. */
  app.get("/api/expressions", async (req) => ex.listExpressions(req.auth.userId));

  // The audio comes as the multipart file; the rest in the query string.
  app.post("/api/sounds", async (req, reply) => {
    limits.uploads.consume(req.auth.userId);
    const meta = parse(soundCreateSchema, req.query);
    const file = await req.file({ limits: { fileSize: MAX_SOUND_BYTES } });
    if (!file) throw badRequest("no_file");
    return reply.code(201).send(await ex.createSound(req.auth.userId, file.file, meta));
  });
  app.patch("/api/sounds/:id", async (req) => ex.updateSound(req.auth.userId, parse(idParam, req.params).id, parse(soundUpdateSchema, req.body)));
  app.delete("/api/sounds/:id", async (req, reply) => {
    await ex.deleteSound(req.auth.userId, parse(idParam, req.params).id);
    return reply.code(204).send();
  });

  app.post("/api/voice-presets", async (req, reply) => reply.code(201).send(await ex.createPreset(req.auth.userId, parse(voicePresetCreateSchema, req.body))));
  app.patch("/api/voice-presets/:id", async (req) => ex.updatePreset(req.auth.userId, parse(idParam, req.params).id, parse(voicePresetUpdateSchema, req.body)));
  app.delete("/api/voice-presets/:id", async (req, reply) => {
    await ex.deletePreset(req.auth.userId, parse(idParam, req.params).id);
    return reply.code(204).send();
  });
}
