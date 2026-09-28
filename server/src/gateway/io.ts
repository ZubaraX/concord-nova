// Holds the Socket.IO server and the typed dispatch helpers every service uses
// to push events. Recipients are always computed from the permission cache,
// so an event can never reach someone who can't see the channel.
import type { Server } from "socket.io";
import type { ClientPlatform, ClientToServerEvents, DispatchMap, DispatchType, ServerToClientEvents } from "@nova/shared";
import { cache } from "../state/cache";

export interface SocketData {
  userId: string;
  sid: string;
  platform: ClientPlatform;
  focus: string | null;
}

export type NovaServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

let io: NovaServer | null = null;
export const setIO = (s: NovaServer | null) => {
  io = s;
};
export const getIO = () => io;

export const rooms = {
  user: (id: string) => `u:${id}`,
  guild: (id: string) => `g:${id}`,
  session: (sid: string) => `s:${sid}`,
};

export function dispatch<K extends DispatchType>(target: string | string[], t: K, d: DispatchMap[K]) {
  if (!io) return;
  if (Array.isArray(target) && target.length === 0) return;
  io.to(target).emit("dispatch", { t, d } as never);
}

export const toUser = <K extends DispatchType>(userId: string, t: K, d: DispatchMap[K]) => dispatch(rooms.user(userId), t, d);

export function toUsers<K extends DispatchType>(userIds: Iterable<string>, t: K, d: DispatchMap[K]) {
  const list = [...new Set(userIds)].map(rooms.user);
  if (list.length) dispatch(list, t, d);
}

export const toGuild = <K extends DispatchType>(guildId: string, t: K, d: DispatchMap[K]) => dispatch(rooms.guild(guildId), t, d);

/** Everyone who can view the channel (guild channel viewers or DM recipients). */
export function toChannel<K extends DispatchType>(channelId: string, t: K, d: DispatchMap[K], exceptUserId?: string) {
  const viewers = cache.viewers(channelId);
  toUsers(exceptUserId ? viewers.filter((u) => u !== exceptUserId) : viewers, t, d);
}

export function joinGuildRoom(userId: string, guildId: string) {
  io?.in(rooms.user(userId)).socketsJoin(rooms.guild(guildId));
}

export function leaveGuildRoom(userId: string, guildId: string) {
  io?.in(rooms.user(userId)).socketsLeave(rooms.guild(guildId));
}

/** Tell a session it's gone, then drop its sockets. */
export function disconnectSession(sid: string, reason: string) {
  if (!io) return;
  io.to(rooms.session(sid)).emit("dispatch", { t: "SESSION_INVALIDATE", d: { reason } });
  setTimeout(() => io?.in(rooms.session(sid)).disconnectSockets(true), 250);
}

export async function connectedUserIds(): Promise<Set<string>> {
  if (!io) return new Set();
  const sockets = await io.fetchSockets();
  return new Set(sockets.map((s) => s.data.userId));
}
