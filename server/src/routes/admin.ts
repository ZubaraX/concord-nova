// /api/admin — instance administration, for instance admins only.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { adminFlagSchema, adminTransferSchema, instanceSettingsSchema } from "@nova/shared";
import { authenticate } from "../lib/auth";
import { forbidden, parse } from "../lib/errors";
import * as admin from "../services/admin";

const idParam = z.object({ id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/) });

export async function adminRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", async (req) => {
    if (!(await admin.isInstanceAdmin(req.auth.userId))) throw forbidden("admin_only");
  });

  app.get("/overview", async () => admin.overview());

  app.get("/users", async (req) => {
    const { q, guild } = parse(z.object({ q: z.string().max(100).optional(), guild: idParam.shape.id.optional() }), req.query);
    return admin.listUsers(q ?? "", guild);
  });
  app.post("/users/:id/password", async (req) => admin.resetPassword(req.auth.userId, parse(idParam, req.params).id));
  app.post("/users/:id/disabled", async (req) => {
    await admin.setDisabled(req.auth.userId, parse(idParam, req.params).id, parse(adminFlagSchema, req.body).value);
    return { ok: true };
  });
  app.post("/users/:id/admin", async (req) => {
    await admin.setAdmin(req.auth.userId, parse(idParam, req.params).id, parse(adminFlagSchema, req.body).value);
    return { ok: true };
  });

  app.get("/guilds", async () => admin.listGuilds());
  app.post("/guilds/:id/owner", async (req) => {
    await admin.transferGuild(parse(idParam, req.params).id, parse(adminTransferSchema, req.body).userId);
    return { ok: true };
  });

  app.put("/settings", async (req) => admin.setInstanceSettings(parse(instanceSettingsSchema, req.body)));
}
