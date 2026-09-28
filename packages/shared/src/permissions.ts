// Permission bitfield (Discord-compatible bit positions). Stored and sent as
// decimal strings because the field is wider than 53 bits.
//
// The same computation runs on the server (authoritative) and in the client
// (to hide controls the user can't use), so both sides always agree.

export const Permission = {
  CREATE_INSTANT_INVITE: 1n << 0n,
  KICK_MEMBERS: 1n << 1n,
  BAN_MEMBERS: 1n << 2n,
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_GUILD: 1n << 5n,
  ADD_REACTIONS: 1n << 6n,
  VIEW_AUDIT_LOG: 1n << 7n,
  PRIORITY_SPEAKER: 1n << 8n,
  STREAM: 1n << 9n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  MANAGE_MESSAGES: 1n << 13n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MENTION_EVERYONE: 1n << 17n,
  USE_EXTERNAL_EMOJIS: 1n << 18n,
  CONNECT: 1n << 20n,
  SPEAK: 1n << 21n,
  MUTE_MEMBERS: 1n << 22n,
  DEAFEN_MEMBERS: 1n << 23n,
  MOVE_MEMBERS: 1n << 24n,
  USE_VAD: 1n << 25n,
  CHANGE_NICKNAME: 1n << 26n,
  MANAGE_NICKNAMES: 1n << 27n,
  MANAGE_ROLES: 1n << 28n,
  MANAGE_EMOJIS: 1n << 30n,
  CREATE_THREADS: 1n << 35n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
  MODERATE_MEMBERS: 1n << 40n,
  SEND_VOICE_MESSAGES: 1n << 46n,
  SEND_POLLS: 1n << 49n,
} as const;

export type PermissionName = keyof typeof Permission;

export const ALL_PERMISSIONS: bigint = Object.values(Permission).reduce((a, b) => a | b, 0n);

/** What @everyone gets in a freshly created server. */
export const DEFAULT_EVERYONE_PERMISSIONS: bigint =
  Permission.CREATE_INSTANT_INVITE |
  Permission.ADD_REACTIONS |
  Permission.STREAM |
  Permission.VIEW_CHANNEL |
  Permission.SEND_MESSAGES |
  Permission.EMBED_LINKS |
  Permission.ATTACH_FILES |
  Permission.READ_MESSAGE_HISTORY |
  Permission.USE_EXTERNAL_EMOJIS |
  Permission.CONNECT |
  Permission.SPEAK |
  Permission.USE_VAD |
  Permission.CHANGE_NICKNAME |
  Permission.CREATE_THREADS |
  Permission.SEND_MESSAGES_IN_THREADS |
  Permission.SEND_VOICE_MESSAGES |
  Permission.SEND_POLLS;

/** Permissions that only make sense guild-wide (ignored in channel overwrites). */
export const GUILD_ONLY_PERMISSIONS: bigint =
  Permission.KICK_MEMBERS |
  Permission.BAN_MEMBERS |
  Permission.ADMINISTRATOR |
  Permission.MANAGE_GUILD |
  Permission.VIEW_AUDIT_LOG |
  Permission.CHANGE_NICKNAME |
  Permission.MANAGE_NICKNAMES |
  Permission.MANAGE_EMOJIS |
  Permission.MODERATE_MEMBERS;

/** Everything a member keeps while timed out (read-only participation). */
export const TIMEOUT_ALLOWED: bigint = Permission.VIEW_CHANNEL | Permission.READ_MESSAGE_HISTORY;

/** Text-only permissions stripped in voice channels' text-less mode are not
 *  modelled — voice channels have their own chat like modern Discord. */

export function parsePerms(v: string | bigint | null | undefined): bigint {
  if (typeof v === "bigint") return v;
  if (!v) return 0n;
  try {
    return BigInt(v);
  } catch {
    return 0n;
  }
}

export function hasPerm(bits: bigint, perm: bigint): boolean {
  if ((bits & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR) return true;
  return (bits & perm) === perm;
}

export interface PermRole {
  id: string;
  permissions: string | bigint;
  position: number;
}

export interface PermOverwrite {
  id: string; // role id or user id
  type: "role" | "member";
  allow: string | bigint;
  deny: string | bigint;
}

export interface PermContext {
  guildId: string;
  ownerId: string;
  /** All roles of the guild; the @everyone role has id === guildId. */
  roles: ReadonlyMap<string, PermRole> | PermRole[];
}

function roleMap(roles: PermContext["roles"]): ReadonlyMap<string, PermRole> {
  if (Array.isArray(roles)) return new Map(roles.map((r) => [r.id, r]));
  return roles as ReadonlyMap<string, PermRole>;
}

/** Guild-level permissions for a member (roles only, no channel overwrites). */
export function computeBasePermissions(
  ctx: PermContext,
  userId: string,
  memberRoleIds: readonly string[],
  timeoutUntil?: number | null
): bigint {
  if (userId === ctx.ownerId) return ALL_PERMISSIONS;
  const roles = roleMap(ctx.roles);
  let bits = parsePerms(roles.get(ctx.guildId)?.permissions);
  for (const id of memberRoleIds) bits |= parsePerms(roles.get(id)?.permissions);
  if (bits & Permission.ADMINISTRATOR) return ALL_PERMISSIONS;
  if (timeoutUntil && timeoutUntil > Date.now()) bits &= TIMEOUT_ALLOWED;
  return bits;
}

/**
 * Channel permissions per the Discord algorithm:
 * base → @everyone overwrite → role overwrites (deny all, then allow all) →
 * member overwrite. Administrators and the owner bypass overwrites. A channel
 * you can't view grants nothing.
 */
export function computeChannelPermissions(
  ctx: PermContext,
  userId: string,
  memberRoleIds: readonly string[],
  overwrites: readonly PermOverwrite[],
  timeoutUntil?: number | null
): bigint {
  const base = computeBasePermissions(ctx, userId, memberRoleIds, timeoutUntil);
  // Owner and administrators bypass overwrites (and timeouts) entirely.
  if (userId === ctx.ownerId || (base & Permission.ADMINISTRATOR) !== 0n) return ALL_PERMISSIONS;
  let bits = base;

  const everyone = overwrites.find((o) => o.type === "role" && o.id === ctx.guildId);
  if (everyone) {
    bits &= ~parsePerms(everyone.deny);
    bits |= parsePerms(everyone.allow);
  }

  let allow = 0n;
  let deny = 0n;
  const roleSet = new Set(memberRoleIds);
  for (const o of overwrites) {
    if (o.type === "role" && o.id !== ctx.guildId && roleSet.has(o.id)) {
      allow |= parsePerms(o.allow);
      deny |= parsePerms(o.deny);
    }
  }
  bits &= ~deny;
  bits |= allow;

  const own = overwrites.find((o) => o.type === "member" && o.id === userId);
  if (own) {
    bits &= ~parsePerms(own.deny);
    bits |= parsePerms(own.allow);
  }

  if (timeoutUntil && timeoutUntil > Date.now()) bits &= TIMEOUT_ALLOWED;
  if (!(bits & Permission.VIEW_CHANNEL)) return 0n;
  // Without SEND_MESSAGES the text-dependent permissions are meaningless.
  if (!(bits & Permission.SEND_MESSAGES)) {
    bits &= ~(Permission.MENTION_EVERYONE | Permission.ATTACH_FILES | Permission.EMBED_LINKS | Permission.SEND_VOICE_MESSAGES | Permission.SEND_POLLS);
  }
  // Without CONNECT, voice permissions are meaningless.
  if (!(bits & Permission.CONNECT)) {
    bits &= ~(Permission.SPEAK | Permission.STREAM | Permission.USE_VAD | Permission.PRIORITY_SPEAKER);
  }
  return bits;
}

/** Highest role position of a member (owner = Infinity). Used for hierarchy checks. */
export function highestRolePosition(ctx: PermContext, userId: string, memberRoleIds: readonly string[]): number {
  if (userId === ctx.ownerId) return Number.POSITIVE_INFINITY;
  const roles = roleMap(ctx.roles);
  let top = 0;
  for (const id of memberRoleIds) top = Math.max(top, roles.get(id)?.position ?? 0);
  return top;
}

/** Ordered list for permission editors (UI groups + i18n keys live in the client). */
export const PERMISSION_GROUPS: { key: string; perms: PermissionName[] }[] = [
  {
    key: "general",
    perms: ["ADMINISTRATOR", "VIEW_CHANNEL", "MANAGE_CHANNELS", "MANAGE_ROLES", "MANAGE_EMOJIS", "VIEW_AUDIT_LOG", "MANAGE_GUILD"],
  },
  {
    key: "membership",
    perms: ["CREATE_INSTANT_INVITE", "CHANGE_NICKNAME", "MANAGE_NICKNAMES", "KICK_MEMBERS", "BAN_MEMBERS", "MODERATE_MEMBERS"],
  },
  {
    key: "text",
    perms: [
      "SEND_MESSAGES",
      "SEND_MESSAGES_IN_THREADS",
      "CREATE_THREADS",
      "EMBED_LINKS",
      "ATTACH_FILES",
      "ADD_REACTIONS",
      "USE_EXTERNAL_EMOJIS",
      "MENTION_EVERYONE",
      "MANAGE_MESSAGES",
      "READ_MESSAGE_HISTORY",
      "SEND_VOICE_MESSAGES",
      "SEND_POLLS",
    ],
  },
  {
    key: "voice",
    perms: ["CONNECT", "SPEAK", "STREAM", "USE_VAD", "PRIORITY_SPEAKER", "MUTE_MEMBERS", "DEAFEN_MEMBERS", "MOVE_MEMBERS"],
  },
];
