// In-memory permission index: every guild's roles, members and channel
// overwrites, plus DM/group-DM recipients. All access checks and "who may
// receive this event" decisions go through here — O(1), no DB round-trips.
// Mutations update it right after the DB write (services call the setters, or
// reloadGuild() after structural changes).
import {
  ALL_PERMISSIONS,
  Permission,
  computeBasePermissions,
  computeChannelPermissions,
  hasPerm,
  highestRolePosition,
  parsePerms,
  type ChannelType,
  type PermOverwrite,
} from "@nova/shared";
import { prisma } from "../db";

export interface CRole {
  id: string;
  permissions: bigint;
  position: number;
  mentionable: boolean;
}
export interface CMember {
  roles: string[];
  timeoutUntil: number | null;
}
export interface CChannel {
  id: string;
  type: ChannelType;
  guildId: string;
  parentId: string | null;
  overwrites: PermOverwrite[];
  locked: boolean;
  archived: boolean;
}
export interface CGuild {
  id: string;
  ownerId: string;
  roles: Map<string, CRole>;
  members: Map<string, CMember>;
  channels: Map<string, CChannel>;
}
export interface CPrivate {
  id: string;
  type: "dm" | "group_dm";
  recipients: Set<string>;
  ownerId: string | null;
}

/** What DM participants may do. */
export const DM_PERMISSIONS =
  Permission.VIEW_CHANNEL |
  Permission.SEND_MESSAGES |
  Permission.READ_MESSAGE_HISTORY |
  Permission.ADD_REACTIONS |
  Permission.ATTACH_FILES |
  Permission.EMBED_LINKS |
  Permission.USE_EXTERNAL_EMOJIS |
  Permission.CONNECT |
  Permission.SPEAK |
  Permission.STREAM |
  Permission.USE_VAD |
  Permission.SEND_VOICE_MESSAGES |
  Permission.SEND_POLLS;

type ChannelRow = {
  id: string;
  type: string;
  guildId: string | null;
  parentId: string | null;
  locked: boolean;
  archived: boolean;
  overwrites: { targetId: string; type: string; allow: string; deny: string }[];
};

function toCChannel(c: ChannelRow): CChannel {
  return {
    id: c.id,
    type: c.type as ChannelType,
    guildId: c.guildId!,
    parentId: c.parentId,
    locked: c.locked,
    archived: c.archived,
    overwrites: c.overwrites.map((o) => ({ id: o.targetId, type: o.type === "member" ? "member" : "role", allow: o.allow, deny: o.deny })),
  };
}

class PermissionCache {
  readonly guilds = new Map<string, CGuild>();
  private readonly channelGuild = new Map<string, string>();
  readonly privates = new Map<string, CPrivate>();
  private readonly userGuilds = new Map<string, Set<string>>();
  private readonly userPrivates = new Map<string, Set<string>>();
  private viewersCache = new Map<string, string[]>();

  async loadAll() {
    this.guilds.clear();
    this.channelGuild.clear();
    this.privates.clear();
    this.userGuilds.clear();
    this.userPrivates.clear();
    this.viewersCache.clear();
    const guilds = await prisma.guild.findMany({ select: { id: true } });
    for (const g of guilds) await this.reloadGuild(g.id);
    const privates = await prisma.channel.findMany({
      where: { type: { in: ["dm", "group_dm"] } },
      select: { id: true, type: true, ownerId: true, recipients: { select: { userId: true } } },
    });
    for (const p of privates) {
      this.setPrivate({ id: p.id, type: p.type as "dm" | "group_dm", ownerId: p.ownerId, recipients: new Set(p.recipients.map((r) => r.userId)) });
    }
  }

  async reloadGuild(guildId: string) {
    const g = await prisma.guild.findUnique({
      where: { id: guildId },
      select: {
        id: true,
        ownerId: true,
        roles: { select: { id: true, permissions: true, position: true, mentionable: true } },
        members: { select: { userId: true, timeoutUntil: true, roles: { select: { roleId: true } } } },
        channels: {
          select: { id: true, type: true, guildId: true, parentId: true, locked: true, archived: true, overwrites: { select: { targetId: true, type: true, allow: true, deny: true } } },
        },
      },
    });
    const old = this.guilds.get(guildId);
    if (old) {
      for (const cid of old.channels.keys()) this.channelGuild.delete(cid);
      for (const uid of old.members.keys()) this.userGuilds.get(uid)?.delete(guildId);
    }
    this.viewersCache.clear();
    if (!g) {
      this.guilds.delete(guildId);
      return;
    }
    const cg: CGuild = {
      id: g.id,
      ownerId: g.ownerId,
      roles: new Map(g.roles.map((r) => [r.id, { id: r.id, permissions: parsePerms(r.permissions), position: r.position, mentionable: r.mentionable }])),
      members: new Map(g.members.map((m) => [m.userId, { roles: m.roles.map((r) => r.roleId), timeoutUntil: m.timeoutUntil?.getTime() ?? null }])),
      channels: new Map(g.channels.map((c) => [c.id, toCChannel(c)])),
    };
    this.guilds.set(guildId, cg);
    for (const cid of cg.channels.keys()) this.channelGuild.set(cid, guildId);
    for (const uid of cg.members.keys()) this.indexUserGuild(uid, guildId);
  }

  dropGuild(guildId: string) {
    const g = this.guilds.get(guildId);
    if (!g) return;
    for (const cid of g.channels.keys()) this.channelGuild.delete(cid);
    for (const uid of g.members.keys()) this.userGuilds.get(uid)?.delete(guildId);
    this.guilds.delete(guildId);
    this.viewersCache.clear();
  }

  private indexUserGuild(userId: string, guildId: string) {
    let s = this.userGuilds.get(userId);
    if (!s) this.userGuilds.set(userId, (s = new Set()));
    s.add(guildId);
  }

  // ── members ────────────────────────────────────────────────────────────
  addMember(guildId: string, userId: string, roles: string[] = [], timeoutUntil: number | null = null) {
    const g = this.guilds.get(guildId);
    if (!g) return;
    g.members.set(userId, { roles, timeoutUntil });
    this.indexUserGuild(userId, guildId);
    this.viewersCache.clear();
  }

  removeMember(guildId: string, userId: string) {
    this.guilds.get(guildId)?.members.delete(userId);
    this.userGuilds.get(userId)?.delete(guildId);
    this.viewersCache.clear();
  }

  setMember(guildId: string, userId: string, patch: Partial<CMember>) {
    const m = this.guilds.get(guildId)?.members.get(userId);
    if (!m) return;
    if (patch.roles) m.roles = patch.roles;
    if (patch.timeoutUntil !== undefined) m.timeoutUntil = patch.timeoutUntil;
    this.viewersCache.clear();
  }

  // ── channels / roles ───────────────────────────────────────────────────
  setChannel(row: ChannelRow) {
    if (!row.guildId) return;
    const g = this.guilds.get(row.guildId);
    if (!g) return;
    g.channels.set(row.id, toCChannel(row));
    this.channelGuild.set(row.id, row.guildId);
    this.viewersCache.clear();
  }

  removeChannel(channelId: string) {
    const gid = this.channelGuild.get(channelId);
    if (gid) this.guilds.get(gid)?.channels.delete(channelId);
    this.channelGuild.delete(channelId);
    const p = this.privates.get(channelId);
    if (p) {
      for (const u of p.recipients) this.userPrivates.get(u)?.delete(channelId);
      this.privates.delete(channelId);
    }
    this.viewersCache.clear();
  }

  setRole(guildId: string, role: { id: string; permissions: string; position: number; mentionable: boolean }) {
    const g = this.guilds.get(guildId);
    if (!g) return;
    g.roles.set(role.id, { id: role.id, permissions: parsePerms(role.permissions), position: role.position, mentionable: role.mentionable });
    this.viewersCache.clear();
  }

  removeRole(guildId: string, roleId: string) {
    const g = this.guilds.get(guildId);
    if (!g) return;
    g.roles.delete(roleId);
    for (const m of g.members.values()) m.roles = m.roles.filter((r) => r !== roleId);
    for (const c of g.channels.values()) c.overwrites = c.overwrites.filter((o) => o.id !== roleId);
    this.viewersCache.clear();
  }

  setPrivate(p: CPrivate) {
    const old = this.privates.get(p.id);
    if (old) for (const u of old.recipients) this.userPrivates.get(u)?.delete(p.id);
    this.privates.set(p.id, p);
    for (const u of p.recipients) {
      let s = this.userPrivates.get(u);
      if (!s) this.userPrivates.set(u, (s = new Set()));
      s.add(p.id);
    }
  }

  // ── queries ────────────────────────────────────────────────────────────
  guild(guildId: string) {
    return this.guilds.get(guildId);
  }

  channel(channelId: string): CChannel | undefined {
    const gid = this.channelGuild.get(channelId);
    return gid ? this.guilds.get(gid)?.channels.get(channelId) : undefined;
  }

  guildOf(channelId: string): string | null {
    return this.channelGuild.get(channelId) ?? null;
  }

  isMember(guildId: string, userId: string): boolean {
    return !!this.guilds.get(guildId)?.members.has(userId);
  }

  member(guildId: string, userId: string): CMember | undefined {
    return this.guilds.get(guildId)?.members.get(userId);
  }

  userGuildIds(userId: string): string[] {
    return [...(this.userGuilds.get(userId) ?? [])];
  }

  userPrivateIds(userId: string): string[] {
    return [...(this.userPrivates.get(userId) ?? [])];
  }

  /** Users sharing at least one guild or private channel with `userId`. */
  relatedUserIds(userId: string): Set<string> {
    const out = new Set<string>();
    for (const gid of this.userGuildIds(userId)) for (const uid of this.guilds.get(gid)?.members.keys() ?? []) out.add(uid);
    for (const cid of this.userPrivateIds(userId)) for (const uid of this.privates.get(cid)?.recipients ?? []) out.add(uid);
    out.delete(userId);
    return out;
  }

  sharesGuild(a: string, b: string): boolean {
    const ga = this.userGuilds.get(a);
    const gb = this.userGuilds.get(b);
    if (!ga || !gb) return false;
    for (const g of ga) if (gb.has(g)) return true;
    return false;
  }

  private ctx(g: CGuild) {
    return { guildId: g.id, ownerId: g.ownerId, roles: g.roles };
  }

  basePerms(guildId: string, userId: string): bigint {
    const g = this.guilds.get(guildId);
    const m = g?.members.get(userId);
    if (!g || !m) return 0n;
    return computeBasePermissions(this.ctx(g), userId, m.roles, m.timeoutUntil);
  }

  hasGuildPerm(guildId: string, userId: string, perm: bigint): boolean {
    return hasPerm(this.basePerms(guildId, userId), perm);
  }

  channelPerms(channelId: string, userId: string): bigint {
    const p = this.privates.get(channelId);
    if (p) return p.recipients.has(userId) ? DM_PERMISSIONS : 0n;
    const gid = this.channelGuild.get(channelId);
    const g = gid ? this.guilds.get(gid) : undefined;
    const c = g?.channels.get(channelId);
    const m = g?.members.get(userId);
    if (!g || !c || !m) return 0n;
    if (c.type === "thread") {
      const parent = c.parentId ? g.channels.get(c.parentId) : undefined;
      if (!parent) return 0n;
      let bits = computeChannelPermissions(this.ctx(g), userId, m.roles, parent.overwrites, m.timeoutUntil);
      if (bits === ALL_PERMISSIONS) return bits;
      // In threads SEND_MESSAGES_IN_THREADS is what counts.
      bits = bits & Permission.SEND_MESSAGES_IN_THREADS ? bits | Permission.SEND_MESSAGES : bits & ~Permission.SEND_MESSAGES;
      if ((c.locked || c.archived) && !(bits & Permission.MANAGE_MESSAGES)) bits &= ~Permission.SEND_MESSAGES;
      return bits;
    }
    return computeChannelPermissions(this.ctx(g), userId, m.roles, c.overwrites, m.timeoutUntil);
  }

  can(channelId: string, userId: string, perm: bigint): boolean {
    return hasPerm(this.channelPerms(channelId, userId), perm);
  }

  canView(channelId: string, userId: string): boolean {
    return this.can(channelId, userId, Permission.VIEW_CHANNEL);
  }

  /** Everyone allowed to see events of a channel. */
  viewers(channelId: string): string[] {
    const p = this.privates.get(channelId);
    if (p) return [...p.recipients];
    const hit = this.viewersCache.get(channelId);
    if (hit) return hit;
    const gid = this.channelGuild.get(channelId);
    const g = gid ? this.guilds.get(gid) : undefined;
    if (!g) return [];
    const out: string[] = [];
    for (const uid of g.members.keys()) if (this.canView(channelId, uid)) out.push(uid);
    this.viewersCache.set(channelId, out);
    return out;
  }

  visibleChannelIds(guildId: string, userId: string): string[] {
    const g = this.guilds.get(guildId);
    if (!g) return [];
    return [...g.channels.keys()].filter((cid) => this.canView(cid, userId));
  }

  /** Snapshot of member → visible channel ids (used to diff visibility changes). */
  visibilityMap(guildId: string): Map<string, Set<string>> {
    const g = this.guilds.get(guildId);
    const out = new Map<string, Set<string>>();
    if (!g) return out;
    for (const uid of g.members.keys()) out.set(uid, new Set(this.visibleChannelIds(guildId, uid)));
    return out;
  }

  topRolePosition(guildId: string, userId: string): number {
    const g = this.guilds.get(guildId);
    const m = g?.members.get(userId);
    if (!g || !m) return -1;
    return highestRolePosition(this.ctx(g), userId, m.roles);
  }

  /** Actor can act on target: owner beats all; otherwise strictly higher top role. */
  outranks(guildId: string, actorId: string, targetId: string): boolean {
    const g = this.guilds.get(guildId);
    if (!g) return false;
    if (targetId === g.ownerId) return false;
    if (actorId === g.ownerId) return true;
    return this.topRolePosition(guildId, actorId) > this.topRolePosition(guildId, targetId);
  }
}

export const cache = new PermissionCache();
