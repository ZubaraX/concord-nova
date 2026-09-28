import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  RelationshipType,
  accountUpdateSchema,
  groupDmCreateSchema,
  notificationSettingSchema,
  profileUpdateSchema,
  relationshipRequestSchema,
  settingsSchema,
  statusSchema,
  zId,
} from "@nova/shared";
import { prisma, jsonParse } from "../db";
import { authenticate } from "../lib/auth";
import { badRequest, notFound, parse } from "../lib/errors";
import * as users from "../services/users";
import * as rel from "../services/relationships";
import { createGroupDm, openDm } from "../services/channels";
import { leaveGuild } from "../services/guilds";
import { listBookmarks, recentMentions, setBookmark } from "../services/messages";
import { toAttachment } from "../services/serialize";

export async function userRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  app.get("/@me", async (req) => users.getSelf(req.auth.userId));
  app.patch("/@me", async (req) => users.updateProfile(req.auth.userId, parse(profileUpdateSchema, req.body)));
  app.patch("/@me/account", { config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } }, async (req) =>
    users.updateAccount(req.auth.userId, req.auth.sid, parse(accountUpdateSchema, req.body))
  );

  app.get("/@me/settings", async (req) => users.getSettings(req.auth.userId));
  app.put("/@me/settings", async (req) => {
    await users.putSettings(req.auth.userId, parse(settingsSchema, req.body));
    return { ok: true };
  });

  app.patch("/@me/status", async (req) => users.setStatus(req.auth.userId, parse(statusSchema, req.body)));

  app.get("/@me/sessions", async (req) => users.listSessions(req.auth.userId, req.auth.sid));
  app.delete("/@me/sessions/:id", async (req, reply) => {
    const { id } = parse(z.object({ id: zId }), req.params);
    if (!(await users.revokeSession(req.auth.userId, id))) throw notFound("unknown_session");
    return reply.code(204).send();
  });
  app.post("/@me/sessions/revoke-others", async (req) => {
    await users.revokeOtherSessions(req.auth.userId, req.auth.sid);
    return { ok: true };
  });

  app.get("/@me/notification-settings", async (req) => users.listNotificationSettings(req.auth.userId));
  app.put("/@me/notification-settings", async (req) => users.putNotificationSetting(req.auth.userId, parse(notificationSettingSchema, req.body)));

  app.get("/@me/mentions", async (req) => {
    const { before } = parse(z.object({ before: zId.optional() }), req.query);
    return recentMentions(req.auth.userId, before);
  });

  app.get("/@me/bookmarks", async (req) => listBookmarks(req.auth.userId));
  app.put("/@me/bookmarks/:messageId", async (req, reply) => {
    const { messageId } = parse(z.object({ messageId: zId }), req.params);
    await setBookmark(req.auth.userId, messageId, true);
    return reply.code(204).send();
  });
  app.delete("/@me/bookmarks/:messageId", async (req, reply) => {
    const { messageId } = parse(z.object({ messageId: zId }), req.params);
    await setBookmark(req.auth.userId, messageId, false);
    return reply.code(204).send();
  });

  app.get("/@me/scheduled", async (req) => {
    const rows = await prisma.scheduledMessage.findMany({ where: { authorId: req.auth.userId }, orderBy: { sendAt: "asc" } });
    const attIds = rows.flatMap((r) => jsonParse<string[]>(r.attachments, []));
    const atts = attIds.length ? await prisma.attachment.findMany({ where: { id: { in: attIds } } }) : [];
    return rows.map((r) => ({
      id: r.id,
      channelId: r.channelId,
      content: r.content,
      sendAt: r.sendAt.toISOString(),
      attachments: atts.filter((a) => jsonParse<string[]>(r.attachments, []).includes(a.id)).map(toAttachment),
    }));
  });
  app.delete("/@me/scheduled/:id", async (req, reply) => {
    const { id } = parse(z.object({ id: zId }), req.params);
    const r = await prisma.scheduledMessage.deleteMany({ where: { id, authorId: req.auth.userId } });
    if (!r.count) throw notFound("unknown_scheduled");
    return reply.code(204).send();
  });

  // Open a DM (recipientId) or create a group DM (recipients[]).
  app.post("/@me/channels", async (req) => {
    const body = req.body as { recipientId?: string; recipients?: string[] } | undefined;
    if (body?.recipientId) return openDm(req.auth.userId, parse(z.object({ recipientId: zId }), body).recipientId);
    const g = parse(groupDmCreateSchema, body);
    return createGroupDm(req.auth.userId, g.recipients, g.name);
  });

  app.delete("/@me/guilds/:guildId", async (req, reply) => {
    const { guildId } = parse(z.object({ guildId: zId }), req.params);
    await leaveGuild(req.auth.userId, guildId);
    return reply.code(204).send();
  });

  app.get("/@me/relationships", async (req) => rel.listRelationships(req.auth.userId));
  app.post("/@me/relationships", async (req) => {
    const { username } = parse(relationshipRequestSchema, req.body);
    const userId = await rel.requestFriendByUsername(req.auth.userId, username);
    return { ok: true, userId };
  });
  app.put("/@me/relationships/:userId", async (req) => {
    const { userId } = parse(z.object({ userId: zId }), req.params);
    const { type } = parse(z.object({ type: z.number().int().optional() }), req.body ?? {});
    if (type === RelationshipType.BLOCKED) await rel.blockUser(req.auth.userId, userId);
    else if (type === undefined || type === RelationshipType.FRIEND) await rel.requestFriend(req.auth.userId, userId);
    else throw badRequest("invalid_type");
    return { ok: true };
  });
  app.delete("/@me/relationships/:userId", async (req, reply) => {
    const { userId } = parse(z.object({ userId: zId }), req.params);
    await rel.removeRelationship(req.auth.userId, userId);
    return reply.code(204).send();
  });

  app.get("/:userId/profile", async (req) => {
    const { userId } = parse(z.object({ userId: zId }), req.params);
    const { guildId } = parse(z.object({ guildId: zId.optional() }), req.query);
    return users.getProfile(req.auth.userId, userId, guildId);
  });
}
