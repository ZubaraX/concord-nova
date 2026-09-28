// Socket.IO gateway. Auth = the same access token as the REST API. Each socket
// joins its user room, session room and guild rooms; on connect it receives
// READY (full state), so reconnects are self-healing by design.
import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { Permission, isUlid, type ChosenStatus, type ClientPlatform } from "@nova/shared";
import { prisma } from "../db";
import { verifyAccessToken } from "../lib/auth";
import { limits } from "../lib/rate";
import { cache } from "../state/cache";
import { presence } from "../state/presence";
import { voice } from "../state/voice";
import { broadcastPresence } from "../services/audience";
import { setStatus } from "../services/users";
import { rooms, setIO, toChannel, type NovaServer, type SocketData } from "./io";
import { buildReady } from "./ready";

const OFFLINE_GRACE_MS = 5_000;
const offlineTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function attachGateway(http: HttpServer, log: { error: (o: unknown, m?: string) => void }): NovaServer {
  const io: NovaServer = new Server(http, {
    cors: { origin: true, credentials: true },
    transports: ["websocket", "polling"],
    pingInterval: 20_000,
    pingTimeout: 25_000,
    maxHttpBufferSize: 256_000,
  });
  setIO(io);

  io.use(async (socket, next) => {
    try {
      const auth = (socket.handshake.auth ?? {}) as { token?: string; platform?: string };
      if (!auth.token) throw new Error("missing token");
      const ctx = await verifyAccessToken(auth.token);
      const platform: ClientPlatform = auth.platform === "desktop" || auth.platform === "mobile" ? auth.platform : "web";
      (socket.data as SocketData) = { userId: ctx.userId, sid: ctx.sid, platform, focus: null };
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const { userId, sid, platform } = socket.data;
    const safe = (fn: () => unknown) => {
      try {
        const r = fn();
        if (r instanceof Promise) r.catch((err) => log.error({ err }, "gateway handler failed"));
      } catch (err) {
        log.error({ err }, "gateway handler failed");
      }
    };

    // ── handlers first, so nothing sent during setup is lost ──
    socket.on("typing", (channelId) =>
      safe(() => {
        if (!isUlid(channelId)) return;
        if (limits.typing.take(`${userId}:${channelId}`) > 0) return;
        if (!cache.can(channelId, userId, Permission.SEND_MESSAGES)) return;
        toChannel(channelId, "TYPING_START", { channelId, userId, timestamp: Date.now() }, userId);
      })
    );

    socket.on("presence", (p) =>
      safe(async () => {
        if (!p || typeof p !== "object") return;
        if (limits.presence.take(`${userId}:${socket.id}`) > 0) return;
        const status = p.status as ChosenStatus | undefined;
        if (Array.isArray(p.activities) || typeof p.afk === "boolean") {
          const activities = Array.isArray(p.activities)
            ? p.activities
                .filter((a) => a && typeof a.name === "string" && ["playing", "listening", "watching", "streaming"].includes(a.type))
                .map((a) => ({ type: a.type, name: String(a.name).slice(0, 128), startedAt: typeof a.startedAt === "number" ? a.startedAt : null }))
            : undefined;
          presence.update(userId, socket.id, { afk: typeof p.afk === "boolean" ? p.afk : undefined, activities });
        }
        if (status && ["online", "idle", "dnd", "invisible"].includes(status)) await setStatus(userId, { status });
        else await broadcastPresence(userId);
      })
    );

    socket.on("voice:self", (p) =>
      safe(() => {
        if (!p || typeof p !== "object") return;
        voice.updateSelf(userId, { selfMute: !!p.selfMute, selfDeaf: !!p.selfDeaf, selfVideo: !!p.selfVideo, selfStream: !!p.selfStream });
      })
    );

    socket.on("voice:sync", (channelId) =>
      safe(() => {
        if (channelId !== null && !isUlid(channelId)) return;
        return voice.verify(userId, channelId);
      })
    );

    socket.on("focus", (channelId) =>
      safe(() => {
        socket.data.focus = channelId && isUlid(channelId) ? channelId : null;
      })
    );

    socket.on("disconnect", () =>
      safe(() => {
        presence.disconnect(userId, socket.id);
        if (presence.isConnected(userId)) return broadcastPresence(userId);
        // Short grace so a quick reconnect doesn't flash "offline" to everyone.
        clearTimeout(offlineTimers.get(userId));
        offlineTimers.set(
          userId,
          setTimeout(() => {
            offlineTimers.delete(userId);
            if (!presence.isConnected(userId)) void broadcastPresence(userId);
          }, OFFLINE_GRACE_MS)
        );
      })
    );

    // ── setup ──
    safe(async () => {
      socket.join([rooms.user(userId), rooms.session(sid), ...cache.userGuildIds(userId).map(rooms.guild)]);
      const u = await prisma.user.findUnique({
        where: { id: userId },
        select: { status: true, customStatusText: true, customStatusEmoji: true, customStatusExpires: true },
      });
      if (!u) return void socket.disconnect(true);
      const expired = u.customStatusExpires && u.customStatusExpires.getTime() < Date.now();
      presence.connect(
        userId,
        socket.id,
        { sid, platform },
        (["online", "idle", "dnd", "invisible"].includes(u.status) ? u.status : "online") as ChosenStatus,
        !expired && (u.customStatusText || u.customStatusEmoji)
          ? { text: u.customStatusText, emoji: u.customStatusEmoji, expiresAt: u.customStatusExpires?.getTime() ?? null }
          : null
      );
      clearTimeout(offlineTimers.get(userId));
      offlineTimers.delete(userId);
      const ready = await buildReady(userId, sid);
      if (!ready || !socket.connected) return;
      socket.emit("dispatch", { t: "READY", d: ready });
      await broadcastPresence(userId);
    });
  });

  return io;
}
