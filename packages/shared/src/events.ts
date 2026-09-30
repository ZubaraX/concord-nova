// Gateway contract. The server sends everything as one `dispatch` event with a
// typed discriminant; on every (re)connect it starts with READY, a complete
// snapshot, so the client never drifts after a network blip.
import type {
  Activity,
  CallDTO,
  ChannelDTO,
  ChosenStatus,
  EmojiDTO,
  GifDTO,
  GuildBaseDTO,
  GuildDTO,
  MemberDTO,
  MessageDTO,
  NotificationSettingDTO,
  PollDTO,
  PresenceDTO,
  ReadyPayload,
  RelationshipDTO,
  RoleDTO,
  SelfUserDTO,
  UserDTO,
  VoiceStateDTO,
} from "./types";

export interface GuildCreatePayload extends GuildDTO {
  users: UserDTO[];
  presences: PresenceDTO[];
  voiceStates: VoiceStateDTO[];
}

export interface DispatchMap {
  READY: ReadyPayload;
  USER_UPDATE: UserDTO;
  SELF_UPDATE: SelfUserDTO;
  USER_SETTINGS_UPDATE: { settings: Record<string, unknown> };
  /** Favourite GIFs changed on another device. */
  USER_GIFS_UPDATE: { added?: GifDTO; removed?: string };
  NOTIFICATION_SETTINGS_UPDATE: { settings: NotificationSettingDTO[] };

  GUILD_CREATE: GuildCreatePayload;
  GUILD_UPDATE: GuildBaseDTO;
  GUILD_DELETE: { id: string };
  GUILD_EMOJIS_UPDATE: { guildId: string; emojis: EmojiDTO[] };

  CHANNEL_CREATE: ChannelDTO;
  CHANNEL_UPDATE: ChannelDTO;
  CHANNEL_DELETE: { id: string; guildId: string | null };
  CHANNEL_POSITIONS_UPDATE: { guildId: string; positions: { id: string; position: number; parentId: string | null }[] };
  CHANNEL_PINS_UPDATE: { channelId: string; lastPinAt: string | null };

  GUILD_ROLE_CREATE: RoleDTO;
  GUILD_ROLE_UPDATE: RoleDTO;
  GUILD_ROLE_DELETE: { guildId: string; roleId: string };
  GUILD_ROLE_POSITIONS_UPDATE: { guildId: string; positions: { id: string; position: number }[] };

  GUILD_MEMBER_ADD: MemberDTO & { user: UserDTO };
  GUILD_MEMBER_UPDATE: MemberDTO & { user: UserDTO };
  GUILD_MEMBER_REMOVE: { guildId: string; userId: string };

  MESSAGE_CREATE: MessageDTO;
  MESSAGE_UPDATE: MessageDTO;
  MESSAGE_DELETE: { id: string; channelId: string };
  MESSAGE_DELETE_BULK: { ids: string[]; channelId: string };
  MESSAGE_REACTION_ADD: { channelId: string; messageId: string; emoji: string; userId: string };
  MESSAGE_REACTION_REMOVE: { channelId: string; messageId: string; emoji: string; userId: string };
  MESSAGE_REACTION_REMOVE_EMOJI: { channelId: string; messageId: string; emoji: string };
  MESSAGE_POLL_UPDATE: { channelId: string; messageId: string; poll: PollDTO };
  MESSAGE_ACK: { channelId: string; messageId: string | null; mentionCount: number };

  TYPING_START: { channelId: string; userId: string; timestamp: number };
  PRESENCE_UPDATE: PresenceDTO;

  RELATIONSHIP_ADD: RelationshipDTO & { user: UserDTO };
  RELATIONSHIP_REMOVE: { userId: string };

  VOICE_STATE_UPDATE: VoiceStateDTO;
  /** A moderator moved you (or you joined elsewhere) — switch rooms. */
  VOICE_MOVE: { channelId: string | null };
  CALL_CREATE: CallDTO;
  CALL_UPDATE: CallDTO;
  CALL_DELETE: { channelId: string };

  /** The session was revoked (sign-out elsewhere, password change). */
  SESSION_INVALIDATE: { reason: string };
}

export type DispatchType = keyof DispatchMap;
export type DispatchEvent = { [K in DispatchType]: { t: K; d: DispatchMap[K] } }[DispatchType];

export interface PresenceUpdateInput {
  status?: ChosenStatus;
  activities?: Activity[];
  /** Client-side inactivity (auto-idle) — doesn't change the chosen status. */
  afk?: boolean;
}

export interface VoiceSelfInput {
  selfMute: boolean;
  selfDeaf: boolean;
  selfVideo?: boolean;
  selfStream?: boolean;
}

export interface ServerToClientEvents {
  dispatch: (e: DispatchEvent) => void;
}

export interface ClientToServerEvents {
  typing: (channelId: string) => void;
  presence: (p: PresenceUpdateInput) => void;
  "voice:self": (p: VoiceSelfInput) => void;
  /** Client-side view of its voice connection; the server verifies it against LiveKit. */
  "voice:sync": (channelId: string | null) => void;
  /** The channel currently on screen — suppresses push/mention noise for it. */
  focus: (channelId: string | null) => void;
}
