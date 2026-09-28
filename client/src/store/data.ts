// Normalized client state, built from READY and kept current by gateway
// dispatches. Every reducer is a pure update of the affected maps only, so
// zustand selectors re-render just the components that care.
import { create } from "zustand";
import {
  RelationshipType,
  computeChannelPermissions,
  computeBasePermissions,
  hasPerm,
  ALL_PERMISSIONS,
  Permission,
  compareIds,
  type CallDTO,
  type ChannelDTO,
  type DispatchEvent,
  type EmojiDTO,
  type GuildBaseDTO,
  type GuildDTO,
  type MemberDTO,
  type NotificationSettingDTO,
  type PresenceDTO,
  type ReadStateDTO,
  type ReadyPayload,
  type RelationshipDTO,
  type RoleDTO,
  type SelfUserDTO,
  type ServerInfoDTO,
  type UserDTO,
  type VoiceStateDTO,
} from "@nova/shared";

export interface DataState {
  ready: boolean;
  me: SelfUserDTO | null;
  sessionId: string | null;
  server: ServerInfoDTO | null;
  users: Record<string, UserDTO>;
  guilds: Record<string, GuildBaseDTO>;
  guildIds: string[];
  roles: Record<string, Record<string, RoleDTO>>;
  members: Record<string, Record<string, MemberDTO>>;
  emojis: Record<string, EmojiDTO[]>;
  channels: Record<string, ChannelDTO>;
  relationships: Record<string, RelationshipDTO>;
  readStates: Record<string, ReadStateDTO>;
  presences: Record<string, PresenceDTO>;
  voiceStates: Record<string, VoiceStateDTO>;
  calls: Record<string, CallDTO>;
  notif: Record<string, NotificationSettingDTO>;
  /** channelId → userId → expiry (ms) */
  typing: Record<string, Record<string, number>>;
  syncedSettings: Record<string, unknown>;
}

const empty = (): DataState => ({
  ready: false,
  me: null,
  sessionId: null,
  server: null,
  users: {},
  guilds: {},
  guildIds: [],
  roles: {},
  members: {},
  emojis: {},
  channels: {},
  relationships: {},
  readStates: {},
  presences: {},
  voiceStates: {},
  calls: {},
  notif: {},
  typing: {},
  syncedSettings: {},
});

export const useData = create<DataState>(() => empty());
export const data = () => useData.getState();
export const resetData = () => useData.setState(empty(), true);

const byKey = <T,>(arr: T[], key: (x: T) => string): Record<string, T> => Object.fromEntries(arr.map((x) => [key(x), x]));

function withGuild(s: DataState, g: GuildDTO): Partial<DataState> {
  const { roles, channels, members, emojis, ...base } = g;
  const ch = { ...s.channels };
  // Drop stale channels of this guild (a re-sent guild replaces them).
  for (const [id, c] of Object.entries(ch)) if (c.guildId === g.id) delete ch[id];
  for (const c of channels) ch[c.id] = c;
  return {
    guilds: { ...s.guilds, [g.id]: base },
    guildIds: s.guildIds.includes(g.id) ? s.guildIds : [...s.guildIds, g.id],
    roles: { ...s.roles, [g.id]: byKey(roles, (r) => r.id) },
    members: { ...s.members, [g.id]: byKey(members, (m) => m.userId) },
    emojis: { ...s.emojis, [g.id]: emojis },
    channels: ch,
  };
}

function applyReady(r: ReadyPayload): DataState {
  let s: DataState = {
    ...empty(),
    ready: true,
    me: r.user,
    sessionId: r.sessionId,
    server: r.server,
    users: byKey(r.users, (u) => u.id),
    relationships: byKey(r.relationships, (x) => x.userId),
    readStates: byKey(r.readStates, (x) => x.channelId),
    presences: byKey(r.presences, (p) => p.userId),
    voiceStates: byKey(r.voiceStates.filter((v) => v.channelId), (v) => v.userId),
    calls: byKey(r.calls, (c) => c.channelId),
    notif: byKey(r.notificationSettings, (n) => n.targetId),
    syncedSettings: r.settings ?? {},
  };
  for (const g of r.guilds) s = { ...s, ...withGuild(s, g) };
  const ch = { ...s.channels };
  for (const c of r.privateChannels) ch[c.id] = c;
  s.channels = ch;
  // Honor a saved server order.
  const order = (r.settings?.guildOrder as string[] | undefined) ?? [];
  s.guildIds = [...order.filter((id) => s.guilds[id]), ...s.guildIds.filter((id) => !order.includes(id))];
  s.users[r.user.id] = { id: r.user.id, username: r.user.username, displayName: r.user.displayName, avatar: r.user.avatar, accentColor: r.user.accentColor, flags: r.user.flags };
  return s;
}

function patch<T>(map: Record<string, T>, id: string, value: T | undefined): Record<string, T> {
  const next = { ...map };
  if (value === undefined) delete next[id];
  else next[id] = value;
  return next;
}

function mentionsMe(s: DataState, m: { mentions: string[]; mentionRoles: string[]; mentionEveryone: boolean; guildId: string | null }): boolean {
  const me = s.me?.id;
  if (!me) return false;
  if (m.mentions.includes(me) || m.mentionEveryone) return true;
  if (m.guildId && m.mentionRoles.length) {
    const mine = s.members[m.guildId]?.[me]?.roles ?? [];
    return m.mentionRoles.some((r) => mine.includes(r));
  }
  return false;
}

export function applyDispatch(e: DispatchEvent) {
  const s = useData.getState();
  const set = (p: Partial<DataState>) => useData.setState(p);
  switch (e.t) {
    case "READY":
      useData.setState(applyReady(e.d), true);
      return;
    case "USER_UPDATE":
      set({ users: patch(s.users, e.d.id, e.d) });
      return;
    case "SELF_UPDATE": {
      const u = e.d;
      set({ me: u, users: patch(s.users, u.id, { id: u.id, username: u.username, displayName: u.displayName, avatar: u.avatar, accentColor: u.accentColor, flags: u.flags }) });
      return;
    }
    case "USER_SETTINGS_UPDATE":
      set({ syncedSettings: e.d.settings });
      return;
    case "NOTIFICATION_SETTINGS_UPDATE":
      set({ notif: byKey(e.d.settings, (n) => n.targetId) });
      return;
    case "GUILD_CREATE": {
      const { users, presences, voiceStates, ...g } = e.d;
      const u = { ...s.users };
      for (const x of users) u[x.id] = x;
      const p = { ...s.presences };
      for (const x of presences) p[x.userId] = x;
      const v = { ...s.voiceStates };
      for (const x of voiceStates) if (x.channelId) v[x.userId] = x;
      set({ ...withGuild(s, g), users: u, presences: p, voiceStates: v });
      return;
    }
    case "GUILD_UPDATE":
      set({ guilds: patch(s.guilds, e.d.id, e.d) });
      return;
    case "GUILD_DELETE": {
      const id = e.d.id;
      const ch = { ...s.channels };
      for (const [cid, c] of Object.entries(ch)) if (c.guildId === id) delete ch[cid];
      set({
        guilds: patch(s.guilds, id, undefined),
        guildIds: s.guildIds.filter((g) => g !== id),
        roles: patch(s.roles, id, undefined),
        members: patch(s.members, id, undefined),
        emojis: patch(s.emojis, id, undefined),
        channels: ch,
      });
      return;
    }
    case "GUILD_EMOJIS_UPDATE":
      set({ emojis: { ...s.emojis, [e.d.guildId]: e.d.emojis } });
      return;
    case "CHANNEL_CREATE":
    case "CHANNEL_UPDATE":
      set({ channels: patch(s.channels, e.d.id, e.d) });
      return;
    case "CHANNEL_DELETE":
      set({ channels: patch(s.channels, e.d.id, undefined) });
      return;
    case "CHANNEL_POSITIONS_UPDATE": {
      const ch = { ...s.channels };
      for (const p of e.d.positions) if (ch[p.id]) ch[p.id] = { ...ch[p.id], position: p.position, parentId: p.parentId };
      set({ channels: ch });
      return;
    }
    case "CHANNEL_PINS_UPDATE": {
      const c = s.channels[e.d.channelId];
      if (c) set({ channels: patch(s.channels, c.id, { ...c, lastPinAt: e.d.lastPinAt }) });
      return;
    }
    case "GUILD_ROLE_CREATE":
    case "GUILD_ROLE_UPDATE":
      set({ roles: { ...s.roles, [e.d.guildId]: { ...(s.roles[e.d.guildId] ?? {}), [e.d.id]: e.d } } });
      return;
    case "GUILD_ROLE_DELETE": {
      const r = { ...(s.roles[e.d.guildId] ?? {}) };
      delete r[e.d.roleId];
      const members = { ...(s.members[e.d.guildId] ?? {}) };
      for (const [uid, m] of Object.entries(members)) if (m.roles.includes(e.d.roleId)) members[uid] = { ...m, roles: m.roles.filter((x) => x !== e.d.roleId) };
      set({ roles: { ...s.roles, [e.d.guildId]: r }, members: { ...s.members, [e.d.guildId]: members } });
      return;
    }
    case "GUILD_ROLE_POSITIONS_UPDATE": {
      const r = { ...(s.roles[e.d.guildId] ?? {}) };
      for (const p of e.d.positions) if (r[p.id]) r[p.id] = { ...r[p.id], position: p.position };
      set({ roles: { ...s.roles, [e.d.guildId]: r } });
      return;
    }
    case "GUILD_MEMBER_ADD":
    case "GUILD_MEMBER_UPDATE": {
      const { user, ...m } = e.d;
      set({
        users: patch(s.users, user.id, user),
        members: { ...s.members, [m.guildId]: { ...(s.members[m.guildId] ?? {}), [m.userId]: m } },
      });
      return;
    }
    case "GUILD_MEMBER_REMOVE": {
      const g = { ...(s.members[e.d.guildId] ?? {}) };
      delete g[e.d.userId];
      set({ members: { ...s.members, [e.d.guildId]: g } });
      return;
    }
    case "MESSAGE_CREATE": {
      const m = e.d;
      const c = s.channels[m.channelId];
      const upd: Partial<DataState> = {};
      if (c && compareIds(m.id, c.lastMessageId) > 0) upd.channels = patch(s.channels, c.id, { ...c, lastMessageId: m.id });
      const mine = m.author.id === s.me?.id;
      const rs = s.readStates[m.channelId];
      if (mine) upd.readStates = patch(s.readStates, m.channelId, { channelId: m.channelId, lastReadId: m.id, mentionCount: 0 });
      else if (!(m.flags & (1 << 12)) && (!m.guildId || mentionsMe(s, m)))
        upd.readStates = patch(s.readStates, m.channelId, { channelId: m.channelId, lastReadId: rs?.lastReadId ?? null, mentionCount: (rs?.mentionCount ?? 0) + 1 });
      const typing = s.typing[m.channelId];
      if (typing?.[m.author.id]) {
        const t = { ...typing };
        delete t[m.author.id];
        upd.typing = { ...s.typing, [m.channelId]: t };
      }
      if (!s.users[m.author.id]) upd.users = patch(s.users, m.author.id, m.author);
      set(upd);
      return;
    }
    case "MESSAGE_ACK":
      set({ readStates: patch(s.readStates, e.d.channelId, { channelId: e.d.channelId, lastReadId: e.d.messageId, mentionCount: e.d.mentionCount }) });
      return;
    case "TYPING_START":
      set({ typing: { ...s.typing, [e.d.channelId]: { ...(s.typing[e.d.channelId] ?? {}), [e.d.userId]: Date.now() + 9000 } } });
      return;
    case "PRESENCE_UPDATE":
      set({ presences: patch(s.presences, e.d.userId, e.d.status === "offline" ? undefined : e.d) });
      return;
    case "RELATIONSHIP_ADD": {
      const { user, ...rel } = e.d;
      set({ relationships: patch(s.relationships, rel.userId, rel), users: patch(s.users, user.id, user) });
      return;
    }
    case "RELATIONSHIP_REMOVE":
      set({ relationships: patch(s.relationships, e.d.userId, undefined) });
      return;
    case "VOICE_STATE_UPDATE":
      set({ voiceStates: patch(s.voiceStates, e.d.userId, e.d.channelId ? e.d : undefined) });
      return;
    case "CALL_CREATE":
    case "CALL_UPDATE":
      set({ calls: patch(s.calls, e.d.channelId, e.d) });
      return;
    case "CALL_DELETE":
      set({ calls: patch(s.calls, e.d.channelId, undefined) });
      return;
    default:
      return;
  }
}

// ── derived helpers ──────────────────────────────────────────────────────────
export function channelPerms(s: DataState, channelId: string | null | undefined): bigint {
  if (!channelId || !s.me) return 0n;
  const c = s.channels[channelId];
  if (!c) return 0n;
  if (!c.guildId) return ALL_PERMISSIONS & ~(Permission.MANAGE_MESSAGES | Permission.ADMINISTRATOR | Permission.MANAGE_CHANNELS);
  const g = s.guilds[c.guildId];
  const m = s.members[c.guildId]?.[s.me.id];
  if (!g || !m) return 0n;
  const roles = Object.values(s.roles[c.guildId] ?? {});
  const ctx = { guildId: g.id, ownerId: g.ownerId, roles };
  const timeout = m.timeoutUntil ? Date.parse(m.timeoutUntil) : null;
  const target = c.type === "thread" && c.parentId ? s.channels[c.parentId] ?? c : c;
  let bits = computeChannelPermissions(ctx, s.me.id, m.roles, target.overwrites, timeout);
  if (c.type === "thread" && bits !== ALL_PERMISSIONS) {
    bits = bits & Permission.SEND_MESSAGES_IN_THREADS ? bits | Permission.SEND_MESSAGES : bits & ~Permission.SEND_MESSAGES;
    if ((c.thread?.locked || c.thread?.archived) && !(bits & Permission.MANAGE_MESSAGES)) bits &= ~Permission.SEND_MESSAGES;
  }
  return bits;
}

export function guildPerms(s: DataState, guildId: string | null | undefined): bigint {
  if (!guildId || !s.me) return 0n;
  const g = s.guilds[guildId];
  const m = s.members[guildId]?.[s.me.id];
  if (!g || !m) return 0n;
  return computeBasePermissions({ guildId, ownerId: g.ownerId, roles: Object.values(s.roles[guildId] ?? {}) }, s.me.id, m.roles, m.timeoutUntil ? Date.parse(m.timeoutUntil) : null);
}

export const can = (bits: bigint, perm: bigint) => hasPerm(bits, perm);

export function isUnread(s: DataState, channelId: string): boolean {
  const c = s.channels[channelId];
  if (!c?.lastMessageId) return false;
  const rs = s.readStates[channelId];
  return compareIds(c.lastMessageId, rs?.lastReadId) > 0;
}

export function isMuted(s: DataState, channelId: string, guildId?: string | null): boolean {
  const now = Date.now();
  const check = (id?: string | null) => {
    const n = id ? s.notif[id] : undefined;
    return !!n?.muted && (!n.muteUntil || n.muteUntil > now);
  };
  const c = s.channels[channelId];
  return check(channelId) || check(guildId ?? c?.guildId) || (!!c?.parentId && check(c.parentId));
}

export function mentionCount(s: DataState, channelId: string): number {
  return s.readStates[channelId]?.mentionCount ?? 0;
}

export function guildUnread(s: DataState, guildId: string): { unread: boolean; mentions: number } {
  let unread = false;
  let mentions = 0;
  const guildMuted = isMuted(s, "", guildId);
  for (const c of Object.values(s.channels)) {
    if (c.guildId !== guildId || c.type === "category" || c.type === "voice") continue;
    mentions += mentionCount(s, c.id);
    if (!unread && !guildMuted && !isMuted(s, c.id, guildId) && isUnread(s, c.id)) unread = true;
  }
  return { unread, mentions };
}

export function dmBadgeCount(s: DataState): number {
  let n = 0;
  for (const c of Object.values(s.channels)) if (!c.guildId && (c.type === "dm" || c.type === "group_dm") && !isMuted(s, c.id)) n += mentionCount(s, c.id);
  return n;
}

export function pendingFriendRequests(s: DataState): number {
  return Object.values(s.relationships).filter((r) => r.type === RelationshipType.INCOMING).length;
}

export function privateChannels(s: DataState): ChannelDTO[] {
  return Object.values(s.channels)
    .filter((c) => c.type === "dm" || c.type === "group_dm")
    .sort((a, b) => compareIds(b.lastMessageId ?? b.id, a.lastMessageId ?? a.id));
}

export function dmPartner(s: DataState, c: ChannelDTO): UserDTO | undefined {
  const me = s.me?.id;
  const id = c.recipients.find((r) => r !== me) ?? c.recipients[0];
  return id ? s.users[id] : undefined;
}

export function channelTitle(s: DataState, c: ChannelDTO | undefined): string {
  if (!c) return "";
  if (c.type === "dm") {
    const u = dmPartner(s, c);
    return u ? u.displayName || u.username : "?";
  }
  if (c.type === "group_dm") {
    if (c.name) return c.name;
    const me = s.me?.id;
    return c.recipients
      .filter((r) => r !== me)
      .map((r) => s.users[r]?.displayName || s.users[r]?.username || "?")
      .join(", ");
  }
  return c.name;
}

export function voiceMembers(s: DataState, channelId: string): VoiceStateDTO[] {
  return Object.values(s.voiceStates)
    .filter((v) => v.channelId === channelId)
    .sort((a, b) => a.joinedAt - b.joinedAt);
}

export function displayName(s: DataState, userId: string, guildId?: string | null): string {
  const u = s.users[userId];
  const nick = guildId ? s.members[guildId]?.[userId]?.nick : null;
  return nick || u?.displayName || u?.username || "…";
}

export function roleColor(s: DataState, guildId: string | null | undefined, userId: string): string | undefined {
  if (!guildId) return undefined;
  const m = s.members[guildId]?.[userId];
  if (!m) return undefined;
  const roles = s.roles[guildId] ?? {};
  let best: RoleDTO | undefined;
  for (const id of m.roles) {
    const r = roles[id];
    if (r?.color && (!best || r.position > best.position)) best = r;
  }
  return best ? "#" + best.color.toString(16).padStart(6, "0") : undefined;
}
