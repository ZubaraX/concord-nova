// Fastify app assembly (separate from index.ts so tests can build it too).
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { registerErrorHandler } from "./lib/errors";
import { storageDir, cacheDir } from "./lib/files";
import { authRoutes } from "./routes/auth";
import { userRoutes } from "./routes/users";
import { guildRoutes } from "./routes/guilds";
import { channelRoutes } from "./routes/channels";
import { fileRoutes } from "./routes/files";
import { voiceRoutes } from "./routes/voice";
import { diagRoutes, inviteRoutes, pushRoutes } from "./routes/misc";
import { adminRoutes } from "./routes/admin";
import { radioRoutes } from "./routes/radio";
import { expressionRoutes } from "./routes/expressions";

const NON_SPA = /^\/(api|files|socket\.io|media-proxy|rtc|health)(\/|$|\?)/;

export async function buildApp(opts: { logger?: boolean | object } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      opts.logger ??
      (config.isProd ? { level: config.LOG_LEVEL } : config.isTest ? false : { level: config.LOG_LEVEL, transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" } } }),
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 2 * 1024 * 1024,
  });

  mkdirSync(storageDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });

  // Token auth (no cookies) — any origin may call the API: the desktop app
  // (app://nova) and the Android WebView included. @fastify/cors allows only
  // GET/HEAD/POST by default, which made every edit from the apps fail.
  await app.register(cors, {
    origin: true,
    credentials: false,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    maxAge: 86_400,
    exposedHeaders: ["retry-after"],
  });
  await app.register(rateLimit, {
    global: true,
    max: 1200,
    timeWindow: "1 minute",
    // Outside production, local traffic (tests, e2e, dev proxy) is never throttled.
    allowList: (req) =>
      req.url.startsWith("/files/") || req.url.startsWith("/media-proxy") || req.url === "/health" || (!config.isProd && /^(127.|::1$|::ffff:127.)/.test(req.ip)),
  });
  await app.register(multipart, { limits: { files: 1, fields: 10 } });

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    return payload;
  });

  registerErrorHandler(app);

  app.get("/health", async () => ({ ok: true, version: config.version, ts: Date.now() }));

  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(userRoutes, { prefix: "/api/users" });
  await app.register(guildRoutes, { prefix: "/api/guilds" });
  await app.register(channelRoutes, { prefix: "/api/channels" });
  await app.register(inviteRoutes, { prefix: "/api/invites" });
  await app.register(voiceRoutes, { prefix: "/api/voice" });
  await app.register(pushRoutes, { prefix: "/api/push" });
  await app.register(diagRoutes, { prefix: "/api/diag" });
  await app.register(adminRoutes, { prefix: "/api/admin" });
  await app.register(fileRoutes);
  await app.register(expressionRoutes);
  await app.register(radioRoutes);

  // Web client (built into client/dist) — the same app in any browser.
  const index = join(config.webDist, "index.html");
  const hasWeb = existsSync(index);
  if (!hasWeb) {
    app.setNotFoundHandler((req, reply) => {
      reply.code(404).send({ error: { code: "not_found", message: `No route for ${req.method} ${req.url.split("?")[0]}` } });
    });
  } else {
    await app.register(fastifyStatic, {
      root: config.webDist,
      prefix: "/",
      index: false,
      setHeaders(res, path) {
        res.setHeader("Cache-Control", /[\\/]assets[\\/]/.test(path) ? "public, max-age=31536000, immutable" : "no-cache");
      },
    });
    const sendIndex = (reply: import("fastify").FastifyReply) => reply.header("Cache-Control", "no-cache").type("text/html").sendFile("index.html");
    app.get("/", (_req, reply) => sendIndex(reply));
    // Deep links like /invite/CODE go to the app's hash route (/#/invite/CODE).
    // The page can't be served at the deep path itself: the build references
    // its assets relatively (the same build runs from app:// and on Android).
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !NON_SPA.test(req.url) && (req.headers.accept ?? "").includes("text/html")) {
        const path = req.url.split("?")[0];
        return path === "/index.html" ? sendIndex(reply) : reply.redirect(`/#${path}`, 302);
      }
      return reply.code(404).send({ error: { code: "not_found", message: `No route for ${req.method} ${req.url.split("?")[0]}` } });
    });
    app.log.info(`serving web client from ${config.webDist}`);
  }

  return app;
}
