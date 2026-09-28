export const APP_NAME = "Concord Nova";
export const APP_SHORT = "Nova";

export const LIMITS = {
  usernameMin: 2,
  usernameMax: 32,
  displayNameMax: 32,
  passwordMin: 8,
  passwordMax: 128,
  bioMax: 1000,
  pronounsMax: 40,
  customStatusMax: 128,
  guildNameMin: 2,
  guildNameMax: 100,
  guildDescriptionMax: 500,
  channelNameMax: 100,
  channelTopicMax: 1024,
  roleNameMax: 100,
  /** Hard ceiling; the server's MAX_MESSAGE_LENGTH may be lower. */
  messageMax: 100_000,
  attachmentsPerMessage: 10,
  reactionsPerMessage: 20,
  pollOptionsMin: 2,
  pollOptionsMax: 10,
  pollQuestionMax: 300,
  pollOptionMax: 100,
  groupDmMax: 10,
  emojiNameMin: 2,
  emojiNameMax: 32,
  nickMax: 32,
  slowmodeMax: 21_600,
  messagesPageMax: 100,
} as const;

/** Username rules: lowercase latin letters, digits, "_" and "." (no "..", no edge dots). */
export const USERNAME_RE = /^(?!.*\.\.)(?!\.)(?!.*\.$)[a-z0-9_.]{2,32}$/;
export const EMOJI_NAME_RE = /^[A-Za-z0-9_]{2,32}$/;

export const MessageType = {
  DEFAULT: 0,
  REPLY: 19,
  CALL: 3,
  CHANNEL_PINNED_MESSAGE: 6,
  GUILD_MEMBER_JOIN: 7,
  THREAD_CREATED: 18,
  THREAD_STARTER: 21,
  POLL_RESULT: 46,
} as const;
export type MessageTypeValue = (typeof MessageType)[keyof typeof MessageType];

/** System message types — immutable, no author edits. */
export const SYSTEM_MESSAGE_TYPES: ReadonlySet<number> = new Set([
  MessageType.CALL,
  MessageType.CHANNEL_PINNED_MESSAGE,
  MessageType.GUILD_MEMBER_JOIN,
  MessageType.THREAD_CREATED,
  MessageType.POLL_RESULT,
]);

export const AttachmentFlags = {
  VOICE_MESSAGE: 1 << 0,
  SPOILER: 1 << 1,
} as const;

export const MessageFlags = {
  SUPPRESS_EMBEDS: 1 << 2,
  SUPPRESS_NOTIFICATIONS: 1 << 12,
  VOICE_MESSAGE: 1 << 13,
} as const;

export const UserFlags = {
  INSTANCE_ADMIN: 1 << 0,
} as const;

export const RelationshipType = {
  FRIEND: 1,
  BLOCKED: 2,
  INCOMING: 3,
  OUTGOING: 4,
} as const;
export type RelationshipTypeValue = (typeof RelationshipType)[keyof typeof RelationshipType];

export const AuditAction = {
  GUILD_UPDATE: "guild_update",
  CHANNEL_CREATE: "channel_create",
  CHANNEL_UPDATE: "channel_update",
  CHANNEL_DELETE: "channel_delete",
  OVERWRITE_UPDATE: "overwrite_update",
  MEMBER_KICK: "member_kick",
  MEMBER_BAN: "member_ban",
  MEMBER_UNBAN: "member_unban",
  MEMBER_UPDATE: "member_update",
  MEMBER_ROLE_UPDATE: "member_role_update",
  MEMBER_TIMEOUT: "member_timeout",
  MEMBER_VOICE_MOVE: "member_voice_move",
  MEMBER_VOICE_KICK: "member_voice_kick",
  ROLE_CREATE: "role_create",
  ROLE_UPDATE: "role_update",
  ROLE_DELETE: "role_delete",
  INVITE_CREATE: "invite_create",
  INVITE_DELETE: "invite_delete",
  EMOJI_CREATE: "emoji_create",
  EMOJI_DELETE: "emoji_delete",
  MESSAGE_DELETE: "message_delete",
  MESSAGE_PIN: "message_pin",
  MESSAGE_UNPIN: "message_unpin",
} as const;
export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];
