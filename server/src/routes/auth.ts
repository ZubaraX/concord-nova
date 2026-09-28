import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { UserFlags, loginSchema, passwordSchema, registerSchema, ulid, type AuthResponse } from "@nova/shared";
import { prisma } from "../db";
import { ApiError, badRequest, conflict, forbidden, parse, unauthorized } from "../lib/errors";
import { authenticate, createSession, hashPassword, refreshSession, sha256, verifyPassword } from "../lib/auth";
import { sendMail } from "../lib/mail";
import { toSelf } from "../services/serialize";
import { serverInfo } from "../services/info";
import { instance } from "../services/instance";
import { acceptInvite, isInviteUsable } from "../services/invites";
import { revokeSession } from "../services/users";

// Burn comparable time when the account doesn't exist (no user enumeration by timing).
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hashPassword(randomBytes(16).toString("hex")));

export async function authRoutes(app: FastifyInstance) {
  app.get("/info", async () => serverInfo());

  app.post("/register", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (req, reply) => {
    const input = parse(registerSchema, req.body);
    const userCount = await prisma.user.count();
    const first = userCount === 0;
    if (!first) {
      if (instance.registration === "closed") throw forbidden("registration_closed");
      if (instance.registration === "invite" && !(input.invite && (await isInviteUsable(input.invite)))) throw forbidden("invite_required");
    }
    if (await prisma.user.findUnique({ where: { username: input.username } })) throw conflict("username_taken");
    if (await prisma.user.findUnique({ where: { email: input.email } })) throw conflict("email_taken");

    const user = await prisma.user.create({
      data: {
        id: ulid(),
        username: input.username,
        email: input.email,
        passwordHash: await hashPassword(input.password),
        displayName: input.displayName?.trim() || null,
        flags: first ? UserFlags.INSTANCE_ADMIN : 0,
      },
    });
    const tokens = await createSession(user.id, req);
    let joinedGuildId: string | null = null;
    if (input.invite) {
      try {
        joinedGuildId = (await acceptInvite(user.id, input.invite)).guildId;
      } catch {
        /* a bad invite must not fail the registration itself */
      }
    }
    const body: AuthResponse & { joinedGuildId: string | null } = { user: toSelf(user), ...tokens, joinedGuildId };
    return reply.code(201).send(body);
  });

  app.post("/login", { config: { rateLimit: { max: 12, timeWindow: "1 minute" } } }, async (req) => {
    const input = parse(loginSchema, req.body);
    const login = input.login.trim().toLowerCase();
    const user = await prisma.user.findUnique({ where: login.includes("@") ? { email: login } : { username: login } });
    const ok = await verifyPassword(input.password, user?.passwordHash ?? (await getDummyHash()));
    if (!user || !ok) throw unauthorized("invalid_credentials");
    if (user.disabledAt) throw forbidden("account_disabled");
    const tokens = await createSession(user.id, req);
    return { user: toSelf(user), ...tokens } satisfies AuthResponse;
  });

  app.post("/refresh", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req) => {
    const { refreshToken } = parse(z.object({ refreshToken: z.string().min(10).max(200) }), req.body);
    const r = await refreshSession(refreshToken, req);
    return { accessToken: r.accessToken, expiresIn: r.expiresIn };
  });

  app.post("/logout", { preHandler: authenticate }, async (req) => {
    await revokeSession(req.auth.userId, req.auth.sid, "logged_out");
    return { ok: true };
  });

  app.post("/forgot", { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } }, async (req) => {
    const { email } = parse(z.object({ email: z.email() }), req.body);
    const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (user) {
      const code = randomBytes(5).toString("hex").toUpperCase().slice(0, 8);
      await prisma.user.update({
        where: { id: user.id },
        data: { resetCode: sha256(code), resetExpires: new Date(Date.now() + 30 * 60_000), resetAttempts: 0 },
      });
      await sendMail(
        user.email,
        `${instance.serverName} — код для сброса пароля`,
        `Ваш код для сброса пароля: ${code}\n\nВведите его в приложении, чтобы задать новый пароль. Код действует 30 минут.\nЕсли вы не запрашивали сброс — просто проигнорируйте это письмо.`
      );
    }
    // Same answer either way: don't reveal which emails are registered.
    return { ok: true };
  });

  app.post("/reset", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (req) => {
    const input = parse(z.object({ email: z.email(), code: z.string().trim().min(4).max(32), password: passwordSchema }), req.body);
    const user = await prisma.user.findUnique({ where: { email: input.email.trim().toLowerCase() } });
    if (!user || !user.resetCode || !user.resetExpires || user.resetExpires.getTime() < Date.now() || user.resetAttempts >= 5) {
      throw badRequest("invalid_code");
    }
    if (sha256(input.code.toUpperCase()) !== user.resetCode) {
      await prisma.user.update({ where: { id: user.id }, data: { resetAttempts: { increment: 1 } } });
      throw badRequest("invalid_code");
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(input.password), resetCode: null, resetExpires: null, resetAttempts: 0 },
    });
    const sessions = await prisma.session.findMany({ where: { userId: user.id }, select: { id: true } });
    for (const s of sessions) await revokeSession(user.id, s.id, "password_reset");
    return { ok: true };
  });

  app.get("/me", { preHandler: authenticate }, async (req) => {
    const u = await prisma.user.findUnique({ where: { id: req.auth.userId } });
    if (!u) throw new ApiError(404, "unknown_user");
    return { user: toSelf(u) };
  });
}
