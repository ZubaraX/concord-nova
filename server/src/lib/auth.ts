// Auth: bcrypt password hashes, short-lived JWT access tokens bound to a
// server-side session, opaque long-lived refresh tokens (stored hashed).
// Revoking a session kills its access tokens within the cache window and its
// live sockets immediately.
import { compare, hash } from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ulid, type ClientPlatform } from "@nova/shared";
import { prisma } from "../db";
import { config } from "../config";
import { ApiError, unauthorized } from "./errors";

const key = new TextEncoder().encode(config.jwtSecret);
const ISSUER = "concord-nova";

export const hashPassword = (pw: string) => hash(pw, config.isTest ? 4 : 11);
export const verifyPassword = (pw: string, h: string) => compare(pw, h);

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export interface AuthContext {
  userId: string;
  sid: string;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext;
  }
}

async function sign(claims: Record<string, unknown>, sub: string, ttlSec: number) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSec)
    .sign(key);
}

export const signAccessToken = (userId: string, sid: string) => sign({ sid, typ: "a" }, userId, config.ACCESS_TOKEN_TTL);
/** Long-lived token that can ONLY open the Android push stream (typ "p"). */
export const signPushToken = (userId: string, sid: string) => sign({ sid, typ: "p" }, userId, 365 * 86_400);

async function verify(token: string, typ: "a" | "p"): Promise<AuthContext> {
  try {
    const { payload } = await jwtVerify(token, key, { issuer: ISSUER, algorithms: ["HS256"] });
    if (payload.typ !== typ || typeof payload.sub !== "string" || typeof payload.sid !== "string") throw new Error("bad claims");
    return { userId: payload.sub, sid: payload.sid };
  } catch {
    throw unauthorized("invalid_token");
  }
}

// ── session validity cache ────────────────────────────────────────────────
const SESSION_CACHE_MS = 60_000;
const sessionCache = new Map<string, { userId: string; expiresAt: number; checkedAt: number }>();

export async function isSessionValid(sid: string, userId: string): Promise<boolean> {
  const now = Date.now();
  const hit = sessionCache.get(sid);
  if (hit && now - hit.checkedAt < SESSION_CACHE_MS) return hit.userId === userId && hit.expiresAt > now;
  const s = await prisma.session.findUnique({ where: { id: sid }, select: { userId: true, expiresAt: true } });
  if (!s) {
    sessionCache.delete(sid);
    return false;
  }
  sessionCache.set(sid, { userId: s.userId, expiresAt: s.expiresAt.getTime(), checkedAt: now });
  return s.userId === userId && s.expiresAt.getTime() > now;
}

export function forgetSession(sid: string) {
  sessionCache.delete(sid);
}

export async function verifyAccessToken(token: string): Promise<AuthContext> {
  const ctx = await verify(token, "a");
  if (!(await isSessionValid(ctx.sid, ctx.userId))) throw unauthorized("session_revoked");
  return ctx;
}

export async function verifyPushToken(token: string): Promise<AuthContext> {
  const ctx = await verify(token, "p");
  if (!(await isSessionValid(ctx.sid, ctx.userId))) throw unauthorized("session_revoked");
  return ctx;
}

/** Fastify preHandler: requires `Authorization: Bearer <access token>`. */
export async function authenticate(req: FastifyRequest, _reply: FastifyReply) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) throw unauthorized("missing_token");
  req.auth = await verifyAccessToken(h.slice(7).trim());
}

// ── sessions ──────────────────────────────────────────────────────────────
export function describeClient(req: FastifyRequest): { device: string; platform: ClientPlatform } {
  const ua = String(req.headers["user-agent"] ?? "");
  const hinted = String(req.headers["x-nova-platform"] ?? "");
  const platform: ClientPlatform =
    hinted === "desktop" || hinted === "mobile" || hinted === "web"
      ? hinted
      : /Electron/i.test(ua)
        ? "desktop"
        : /Android|iPhone|iPad|Mobile/i.test(ua)
          ? "mobile"
          : "web";
  const os = /Android/i.test(ua)
    ? "Android"
    : /iPhone|iPad/i.test(ua)
      ? "iOS"
      : /Windows/i.test(ua)
        ? "Windows"
        : /Mac OS|Macintosh/i.test(ua)
          ? "macOS"
          : /Linux/i.test(ua)
            ? "Linux"
            : "?";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  const app = platform === "desktop" ? "Desktop" : /; wv\)|Capacitor/i.test(ua) || hinted === "mobile" ? "App" : browser || "Browser";
  return { device: `${os} · ${app}`, platform };
}

export async function createSession(userId: string, req: FastifyRequest) {
  const { device, platform } = describeClient(req);
  const refreshToken = randomBytes(32).toString("base64url");
  const session = await prisma.session.create({
    data: {
      id: ulid(),
      userId,
      refreshHash: sha256(refreshToken),
      device,
      platform,
      ip: req.ip,
      expiresAt: new Date(Date.now() + config.REFRESH_TOKEN_TTL * 1000),
    },
  });
  const accessToken = await signAccessToken(userId, session.id);
  return { accessToken, refreshToken, expiresIn: config.ACCESS_TOKEN_TTL, sessionId: session.id };
}

/** Exchange a refresh token for a new access token (sliding session expiry). */
export async function refreshSession(refreshToken: string, req: FastifyRequest) {
  const session = await prisma.session.findUnique({ where: { refreshHash: sha256(refreshToken) } });
  if (!session || session.expiresAt.getTime() < Date.now()) {
    if (session) await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    throw new ApiError(401, "invalid_refresh_token");
  }
  // Sliding window — but don't write on every refresh from a busy client.
  if (Date.now() - session.lastUsedAt.getTime() > 60 * 60_000) {
    await prisma.session.update({
      where: { id: session.id },
      data: { lastUsedAt: new Date(), ip: req.ip, expiresAt: new Date(Date.now() + config.REFRESH_TOKEN_TTL * 1000) },
    });
  }
  const accessToken = await signAccessToken(session.userId, session.id);
  return { accessToken, expiresIn: config.ACCESS_TOKEN_TTL, userId: session.userId, sessionId: session.id };
}
