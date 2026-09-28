// Wire DTOs shared by server and client. Timestamps are ISO strings unless the
// field name says otherwise (…At number = epoch ms for high-frequency state).
import type { RelationshipTypeValue } from "./constants";

export type ChannelType = "text" | "voice" | "category" | "announcement" | "dm" | "group_dm" | "thread";
export type PresenceStatus = "online" | "idle" | "dnd" | "offline";
export type ChosenStatus = "online" | "idle" | "dnd" | "invisible";
export type ClientPlatform = "desktop" | "mobile" | "web";

export const GUILD_CHANNEL_TYPES: readonly ChannelType[] = ["text", "voice", "category", "announcement"];
export const TEXT_CHANNEL_TYPES: readonly ChannelType[] = ["text", "announcement", "dm", "group_dm", "thread", "voice"];
export const isPrivateChannel = (t: ChannelType) => t === "dm" || t === "group_dm";

export interface UserDTO {
  id: string;
  username: string;
  displayName: string | null;
  avatar: string | null;
  accentColor: number | null;
  flags: number;
}

export interface ProfileDTO extends UserDTO {
  banner: string | null;
  bio: string | null;
  pronouns: string | null;
  createdAt: string;
}

export interface CustomStatus {
  text: string | null;
  emoji: string | null;
  expiresAt: number | null;
}

export interface SelfUserDTO extends ProfileDTO {
  email: string;
  status: ChosenStatus;
  customStatus: CustomStatus | null;
}

export interface Activity {
  type: "playing" | "listening" | "watching" | "streaming";
  name: string;
  startedAt: number | null;
}

export interface PresenceDTO {
  userId: string;
  status: PresenceStatus;
  customStatus: CustomStatus | null;
  activities: Activity[];
  platforms: ClientPlatform[];
}

export interface RoleDTO {
  id: string;
  guildId: string;
  name: string;
  color: number;
  permissions: string;
  position: number;
  hoist: boolean;
  mentionable: boolean;
}

export interface OverwriteDTO {
  id: string;
  type: "role" | "member";
  allow: string;
  deny: string;
}

export interface ThreadMetaDTO {
  archived: boolean;
  locked: boolean;
  messageCount: number;
  starterMessageId: string | null;
}

export interface ChannelDTO {
  id: string;
  type: ChannelType;
  guildId: string | null;
  parentId: string | null;
  name: string;
  topic: string | null;
  position: number;
  nsfw: boolean;
  slowmode: number;
  bitrate: number;
  userLimit: number;
  lastMessageId: string | null;
  lastPinAt: string | null;
  overwrites: OverwriteDTO[];
  /** dm / group_dm: all participants, including yourself. */
  recipients: string[];
  ownerId: string | null;
  icon: string | null;
  thread: ThreadMetaDTO | null;
  createdAt: string;
}

export interface MemberDTO {
  guildId: string;
  userId: string;
  nick: string | null;
  roles: string[];
  joinedAt: string;
  timeoutUntil: string | null;
}

export interface EmojiDTO {
  id: string;
  guildId: string;
  name: string;
  url: string;
  animated: boolean;
}

export interface GuildBaseDTO {
  id: string;
  name: string;
  icon: string | null;
  banner: string | null;
  description: string | null;
  ownerId: string;
  systemChannelId: string | null;
  createdAt: string;
}

export interface GuildDTO extends GuildBaseDTO {
  roles: RoleDTO[];
  /** Only the channels the receiving user can view. */
  channels: ChannelDTO[];
  members: MemberDTO[];
  emojis: EmojiDTO[];
}

export interface AttachmentDTO {
  id: string;
  filename: string;
  url: string;
  size: number;
  contentType: string | null;
  width: number | null;
  height: number | null;
  /** Voice messages: seconds + base64 amplitude samples (0-255). */
  duration: number | null;
  waveform: string | null;
  flags: number;
}

export interface EmbedMedia {
  url: string;
  width?: number | null;
  height?: number | null;
}

export interface EmbedDTO {
  type: "link" | "image" | "video" | "gifv" | "youtube";
  url: string;
  title?: string | null;
  description?: string | null;
  siteName?: string | null;
  color?: number | null;
  image?: EmbedMedia | null;
  thumbnail?: EmbedMedia | null;
  video?: EmbedMedia | null;
  /** youtube: video id for the click-to-play player. */
  videoId?: string | null;
}

export interface ReactionDTO {
  emoji: string;
  count: number;
  users: string[];
}

export interface PollAnswerDTO {
  id: string;
  text: string;
  emoji: string | null;
  votes: number;
  voters: string[];
}

export interface PollDTO {
  question: string;
  answers: PollAnswerDTO[];
  allowMultiselect: boolean;
  expiresAt: string | null;
  finalized: boolean;
}

export interface MessageReferenceDTO {
  id: string;
  channelId: string;
  author: UserDTO | null;
  content: string;
  attachments: number;
  deleted: boolean;
}

export interface MessageDTO {
  id: string;
  channelId: string;
  guildId: string | null;
  author: UserDTO;
  type: number;
  content: string;
  createdAt: string;
  editedAt: string | null;
  pinned: boolean;
  flags: number;
  mentions: string[];
  mentionRoles: string[];
  mentionEveryone: boolean;
  attachments: AttachmentDTO[];
  embeds: EmbedDTO[];
  reactions: ReactionDTO[];
  replyTo: MessageReferenceDTO | null;
  nonce: string | null;
  poll: PollDTO | null;
  thread: { id: string; name: string; messageCount: number; lastMessageId: string | null } | null;
  /** System-message payload (call duration, participants, …). */
  meta: Record<string, unknown> | null;
}

export interface VoiceStateDTO {
  userId: string;
  /** null = the user left voice. */
  channelId: string | null;
  guildId: string | null;
  selfMute: boolean;
  selfDeaf: boolean;
  serverMute: boolean;
  serverDeaf: boolean;
  selfVideo: boolean;
  selfStream: boolean;
  joinedAt: number;
}

export interface CallDTO {
  channelId: string;
  initiatorId: string;
  ringing: string[];
  startedAt: number;
}

export interface ReadStateDTO {
  channelId: string;
  lastReadId: string | null;
  mentionCount: number;
}

export interface RelationshipDTO {
  userId: string;
  type: RelationshipTypeValue;
  since: string;
}

export type NotificationLevel = "default" | "all" | "mentions" | "none";

export interface NotificationSettingDTO {
  targetId: string;
  level: NotificationLevel;
  muted: boolean;
  muteUntil: number | null;
  suppressEveryone: boolean;
}

export interface SessionDTO {
  id: string;
  device: string | null;
  platform: ClientPlatform | null;
  ip: string | null;
  createdAt: string;
  lastUsedAt: string;
  current: boolean;
}

export interface InviteDTO {
  code: string;
  guild: {
    id: string;
    name: string;
    icon: string | null;
    banner: string | null;
    description: string | null;
    memberCount: number;
    onlineCount: number;
  };
  channel: { id: string; name: string; type: ChannelType } | null;
  inviter: UserDTO | null;
  uses: number;
  maxUses: number;
  expiresAt: string | null;
  createdAt: string;
}

export interface AuditEntryDTO {
  id: string;
  guildId: string;
  actorId: string;
  action: string;
  targetId: string | null;
  changes: Record<string, unknown> | null;
  reason: string | null;
  createdAt: string;
}

export interface BanDTO {
  user: UserDTO;
  reason: string | null;
  createdAt: string;
}

export interface ScheduledMessageDTO {
  id: string;
  channelId: string;
  content: string;
  sendAt: string;
  attachments: AttachmentDTO[];
}

export interface ServerInfoDTO {
  name: string;
  version: string;
  voice: { enabled: boolean; url: string | null };
  gifs: boolean;
  maxUploadBytes: number;
  maxMessageLength: number;
  registration: "open" | "invite" | "closed";
  mail: boolean;
  /** Build id of the web client this server serves (null in dev) — open tabs compare it to offer a reload. */
  webBuild: string | null;
}

// ── instance administration ────────────────────────────────────────────────
export type RegistrationMode = "open" | "invite" | "closed";

export interface AdminOverviewDTO {
  version: string;
  node: string;
  uptimeSec: number;
  serverName: string;
  registration: RegistrationMode;
  users: number;
  usersDisabled: number;
  admins: number;
  guilds: number;
  channels: number;
  messages: number;
  attachments: number;
  /** Bytes, as strings (may exceed 2^53). */
  storageBytes: string;
  databaseBytes: string;
  connected: number;
  voice: { participants: number; rooms: number; calls: number };
}

export interface AdminUserDTO {
  id: string;
  username: string;
  displayName: string | null;
  email: string;
  avatar: string | null;
  createdAt: string;
  lastActiveAt: string | null;
  admin: boolean;
  disabled: boolean;
  /** Can't sign in until an admin resets the password (e.g. a public default was locked). */
  passwordLocked: boolean;
  guilds: number;
  sessions: number;
}

export interface AdminGuildDTO {
  id: string;
  name: string;
  icon: string | null;
  ownerId: string;
  ownerName: string;
  /** The owner's account is disabled — the server needs a new owner. */
  ownerDisabled: boolean;
  members: number;
  createdAt: string;
}

export interface ReadyPayload {
  user: SelfUserDTO;
  sessionId: string;
  settings: Record<string, unknown>;
  guilds: GuildDTO[];
  users: UserDTO[];
  privateChannels: ChannelDTO[];
  relationships: RelationshipDTO[];
  readStates: ReadStateDTO[];
  presences: PresenceDTO[];
  voiceStates: VoiceStateDTO[];
  calls: CallDTO[];
  notificationSettings: NotificationSettingDTO[];
  server: ServerInfoDTO;
}

export interface AuthResponse {
  user: SelfUserDTO;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface SearchResultDTO {
  total: number;
  messages: MessageDTO[];
}

export interface GifDTO {
  id: string;
  url: string;
  preview: string;
  width: number | null;
  height: number | null;
}

export interface ApiErrorBody {
  error: { code: string; message: string; fields?: Record<string, string> };
}
