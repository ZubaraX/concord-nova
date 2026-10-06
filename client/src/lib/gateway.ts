// Realtime connection. Every (re)connect starts with READY — a full state
// snapshot — then missed messages are gap-filled, so the client can't drift
// no matter how the connection dropped.
import { io, type Socket } from "socket.io-client";
import { create } from "zustand";
import type { Activity, ChosenStatus, ClientToServerEvents, DispatchEvent, ServerToClientEvents, VoiceSelfInput } from "@nova/shared";
import { freshToken, refreshAccess, tokens } from "./api";
import { serverBase } from "./server";
import { platform } from "./platform";
import { bus } from "./bus";
import { applyDispatch } from "../store/data";
import * as msgs from "../store/messages";
import { settings } from "../store/settings";
import { loadFavorites, onGifsEvent } from "./gifs";
import { loadExpressions, onExpressionEvent } from "../features/voice/expressions";

export type ConnState = "connecting" | "ready" | "reconnecting" | "offline";

export const useConnection = create<{ state: ConnState; everReady: boolean; since: number }>(() => ({
  state: "connecting",
  everReady: false,
  since: Date.now(),
}));

let socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;
let focusChannel: string | null = null;

function setState(state: ConnState) {
  if (useConnection.getState().state !== state) useConnection.setState({ state, since: Date.now() });
}

function handle(e: DispatchEvent) {
  applyDispatch(e);
  switch (e.t) {
    case "READY": {
      const first = !useConnection.getState().everReady;
      useConnection.setState({ everReady: true });
      setState("ready");
      settings().hydrateSynced(e.d.settings ?? {});
      if (!first) void msgs.resyncAll();
      if (focusChannel) socket?.emit("focus", focusChannel);
      void loadFavorites();
      void loadExpressions();
      bus.emit("ready", { first });
      break;
    }
    case "MESSAGE_CREATE":
      msgs.onCreate(e.d);
      break;
    case "MESSAGE_UPDATE":
      msgs.onUpdate(e.d);
      break;
    case "MESSAGE_DELETE":
      msgs.onDelete(e.d.channelId, [e.d.id]);
      break;
    case "MESSAGE_DELETE_BULK":
      msgs.onDelete(e.d.channelId, e.d.ids);
      break;
    case "MESSAGE_REACTION_ADD":
      msgs.onReaction(e.d.channelId, e.d.messageId, e.d.emoji, e.d.userId, true);
      break;
    case "MESSAGE_REACTION_REMOVE":
      msgs.onReaction(e.d.channelId, e.d.messageId, e.d.emoji, e.d.userId, false);
      break;
    case "MESSAGE_REACTION_REMOVE_EMOJI":
      msgs.onReactionEmojiRemoved(e.d.channelId, e.d.messageId, e.d.emoji);
      break;
    case "MESSAGE_POLL_UPDATE":
      msgs.onPoll(e.d.channelId, e.d.messageId, e.d.poll);
      break;
    case "USER_SETTINGS_UPDATE":
      settings().hydrateSynced(e.d.settings);
      break;
    case "USER_GIFS_UPDATE":
      onGifsEvent(e.d);
      break;
    case "SOUND_UPSERT":
    case "SOUND_DELETE":
    case "VOICE_PRESET_UPSERT":
    case "VOICE_PRESET_DELETE":
      onExpressionEvent(e);
      break;
    case "SESSION_INVALIDATE":
      tokens.clear();
      bus.emit("logout", { reason: e.d.reason });
      break;
  }
  bus.emit("dispatch", e);
}

export function connectGateway() {
  if (socket) return;
  setState("connecting");
  socket = io(serverBase() || undefined, {
    path: "/socket.io",
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionDelay: 700,
    reconnectionDelayMax: 10_000,
    randomizationFactor: 0.5,
    timeout: 15_000,
    // Called on every attempt, so a reconnect always carries a fresh token.
    auth: (cb) => {
      freshToken()
        .then((token) => cb({ token: token ?? tokens.access, platform }))
        .catch(() => cb({ token: tokens.access, platform }));
    },
  });

  socket.on("dispatch", handle);
  socket.on("disconnect", (reason) => {
    setState(navigator.onLine ? "reconnecting" : "offline");
    // The server dropped us on purpose (revoked session / restart) — socket.io
    // won't retry by itself in that case.
    if (reason === "io server disconnect") setTimeout(() => socket?.connect(), 1000);
  });
  socket.on("connect_error", async (err) => {
    setState(navigator.onLine ? "reconnecting" : "offline");
    if (err.message === "unauthorized") {
      // Middleware rejections are not retried automatically: refresh, then retry.
      try {
        const t = await refreshAccess();
        if (t) setTimeout(() => socket?.connect(), 500);
      } catch {
        setTimeout(() => socket?.connect(), 3000);
      }
    }
  });
  socket.io.on("reconnect_attempt", () => setState(navigator.onLine ? "reconnecting" : "offline"));
}

export function disconnectGateway() {
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = null;
  useConnection.setState({ state: "connecting", everReady: false });
}

window.addEventListener("online", () => {
  if (socket && !socket.connected) socket.connect();
});
window.addEventListener("offline", () => {
  if (socket) setState("offline");
});

// ── outgoing ────────────────────────────────────────────────────────────────
const lastTyping = new Map<string, number>();

export const gw = {
  typing(channelId: string) {
    const now = Date.now();
    if (now - (lastTyping.get(channelId) ?? 0) < 7000) return;
    lastTyping.set(channelId, now);
    socket?.emit("typing", channelId);
  },
  stopTyping(channelId: string) {
    lastTyping.delete(channelId);
  },
  focus(channelId: string | null) {
    focusChannel = channelId;
    socket?.emit("focus", channelId);
  },
  presence(p: { status?: ChosenStatus; activities?: Activity[]; afk?: boolean }) {
    socket?.emit("presence", p);
  },
  voiceSelf(p: VoiceSelfInput) {
    socket?.emit("voice:self", p);
  },
  voiceSync(channelId: string | null) {
    socket?.emit("voice:sync", channelId);
  },
  get connected() {
    return !!socket?.connected;
  },
};
