// Input validation shared by the server (authoritative) and client forms.
import { z } from "zod";
import { EMOJI_NAME_RE, LIMITS, USERNAME_RE } from "./constants";
import { ULID_RE } from "./ids";

export const zId = z.string().regex(ULID_RE, "invalid_id");
const zBits = z.string().regex(/^\d{1,30}$/, "invalid_permissions");
/** Paths we host ourselves — avatars etc. may never point off-server. */
const zOwnFile = z.string().max(300).regex(/^\/files\/[\w./-]+$/, "invalid_file");
const zColor = z.number().int().min(0).max(0xffffff);
/** Id of a built-in cosmetic preset (avatar decoration, profile effect). */
const zPreset = z.string().regex(/^[a-z0-9-]{1,32}$/);

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(LIMITS.usernameMin)
  .max(LIMITS.usernameMax)
  .regex(USERNAME_RE, "username_invalid");

export const passwordSchema = z.string().min(LIMITS.passwordMin, "password_short").max(LIMITS.passwordMax);

export const registerSchema = z.object({
  username: usernameSchema,
  email: z.email("email_invalid").max(254).transform((v) => v.trim().toLowerCase()),
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(LIMITS.displayNameMax).optional(),
  invite: z.string().trim().max(64).optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  /** Email or username. */
  login: z.string().trim().min(2).max(254),
  password: z.string().min(1).max(LIMITS.passwordMax),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const profileUpdateSchema = z.object({
  displayName: z.string().trim().max(LIMITS.displayNameMax).nullable().optional(),
  avatar: zOwnFile.nullable().optional(),
  banner: zOwnFile.nullable().optional(),
  bio: z.string().max(LIMITS.bioMax).nullable().optional(),
  pronouns: z.string().max(LIMITS.pronounsMax).nullable().optional(),
  accentColor: zColor.nullable().optional(),
  accentColor2: zColor.nullable().optional(),
  decoration: zPreset.nullable().optional(),
  profileEffect: zPreset.nullable().optional(),
});
export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>;

export const accountUpdateSchema = z.object({
  password: z.string().min(1).max(LIMITS.passwordMax),
  username: usernameSchema.optional(),
  email: z.email().max(254).transform((v) => v.trim().toLowerCase()).optional(),
  newPassword: passwordSchema.optional(),
});

export const customStatusSchema = z.object({
  text: z.string().max(LIMITS.customStatusMax).nullable(),
  emoji: z.string().max(64).nullable(),
  expiresAt: z.number().int().nullable(),
});

export const statusSchema = z.object({
  status: z.enum(["online", "idle", "dnd", "invisible"]).optional(),
  customStatus: customStatusSchema.nullable().optional(),
});

export const guildCreateSchema = z.object({
  name: z.string().trim().min(LIMITS.guildNameMin).max(LIMITS.guildNameMax),
  icon: zOwnFile.nullable().optional(),
  template: z.enum(["default", "gaming", "friends", "study", "empty"]).default("default"),
  locale: z.enum(["ru", "en"]).default("ru"),
});

export const guildUpdateSchema = z.object({
  name: z.string().trim().min(LIMITS.guildNameMin).max(LIMITS.guildNameMax).optional(),
  icon: zOwnFile.nullable().optional(),
  banner: zOwnFile.nullable().optional(),
  description: z.string().max(LIMITS.guildDescriptionMax).nullable().optional(),
  systemChannelId: zId.nullable().optional(),
});

export const overwriteSchema = z.object({
  id: zId,
  type: z.enum(["role", "member"]),
  allow: zBits,
  deny: zBits,
});

export const channelCreateSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.channelNameMax),
  type: z.enum(["text", "voice", "category", "announcement"]).default("text"),
  parentId: zId.nullable().optional(),
  topic: z.string().max(LIMITS.channelTopicMax).nullable().optional(),
  nsfw: z.boolean().optional(),
  bitrate: z.number().int().min(8_000).max(510_000).optional(),
  userLimit: z.number().int().min(0).max(99).optional(),
  /** Private channel: only these roles/members (plus admins) can see it. */
  overwrites: z.array(overwriteSchema).max(100).optional(),
});
export type ChannelCreateInput = z.infer<typeof channelCreateSchema>;

export const channelUpdateSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.channelNameMax).optional(),
  topic: z.string().max(LIMITS.channelTopicMax).nullable().optional(),
  nsfw: z.boolean().optional(),
  slowmode: z.number().int().min(0).max(LIMITS.slowmodeMax).optional(),
  bitrate: z.number().int().min(8_000).max(510_000).optional(),
  userLimit: z.number().int().min(0).max(99).optional(),
  parentId: zId.nullable().optional(),
  overwrites: z.array(overwriteSchema).max(100).optional(),
  /** group DM */
  icon: zOwnFile.nullable().optional(),
  /** threads */
  archived: z.boolean().optional(),
  locked: z.boolean().optional(),
});

export const threadCreateSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.channelNameMax),
  messageId: zId.optional(),
});

export const channelPositionsSchema = z
  .array(z.object({ id: zId, position: z.number().int().min(0).max(10_000), parentId: zId.nullable().optional() }))
  .min(1)
  .max(500);

export const roleCreateSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.roleNameMax).default("новая роль"),
  color: zColor.default(0),
  permissions: zBits.optional(),
  hoist: z.boolean().default(false),
  mentionable: z.boolean().default(false),
});

export const roleUpdateSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.roleNameMax).optional(),
  color: zColor.optional(),
  permissions: zBits.optional(),
  hoist: z.boolean().optional(),
  mentionable: z.boolean().optional(),
});

export const rolePositionsSchema = z.array(z.object({ id: zId, position: z.number().int().min(1).max(10_000) })).min(1).max(250);

export const memberUpdateSchema = z.object({
  nick: z.string().trim().max(LIMITS.nickMax).nullable().optional(),
  roles: z.array(zId).max(250).optional(),
  /** ISO date or null to lift a timeout. */
  timeoutUntil: z.iso.datetime().nullable().optional(),
  reason: z.string().max(512).optional(),
});

export const banSchema = z.object({
  reason: z.string().max(512).optional(),
  /** Delete this many seconds of the user's recent messages (0–7 days). */
  deleteMessageSeconds: z.number().int().min(0).max(604_800).default(0),
});

export const pollInputSchema = z.object({
  question: z.string().trim().min(1).max(LIMITS.pollQuestionMax),
  answers: z
    .array(z.object({ text: z.string().trim().min(1).max(LIMITS.pollOptionMax), emoji: z.string().max(64).nullable().optional() }))
    .min(LIMITS.pollOptionsMin)
    .max(LIMITS.pollOptionsMax),
  allowMultiselect: z.boolean().default(false),
  /** 0 = never expires. */
  durationHours: z.number().int().min(0).max(24 * 30).default(24),
});

export const messageCreateSchema = z.object({
  content: z.string().max(LIMITS.messageMax).default(""),
  nonce: z.string().min(1).max(64).optional(),
  replyTo: zId.optional(),
  /** Ids returned by the upload endpoint; claimed by this message. */
  attachments: z.array(zId).max(LIMITS.attachmentsPerMessage).optional(),
  /** Subset of `attachments` to hide behind a spoiler. */
  spoilers: z.array(zId).max(LIMITS.attachmentsPerMessage).optional(),
  poll: pollInputSchema.optional(),
  /** Silent message: no push/sound for recipients. */
  silent: z.boolean().optional(),
  /** Don't ping the author of the replied-to message. */
  replyMention: z.boolean().optional(),
});
export type MessageCreateInput = z.infer<typeof messageCreateSchema>;

export const messageEditSchema = z.object({
  content: z.string().max(LIMITS.messageMax),
  suppressEmbeds: z.boolean().optional(),
});

export const pollVoteSchema = z.object({ answers: z.array(z.string().min(1).max(32)).max(LIMITS.pollOptionsMax) });

export const inviteCreateSchema = z.object({
  /** Seconds; 0 = never expires. */
  maxAge: z.number().int().min(0).max(30 * 86_400).default(7 * 86_400),
  maxUses: z.number().int().min(0).max(1000).default(0),
  channelId: zId.optional(),
});

/** Free text: a username ("@name", old "Name#1234") or an exact display name — resolved server-side. */
export const relationshipRequestSchema = z.object({ username: z.string().trim().min(1).max(64) });

export const groupDmCreateSchema = z.object({
  recipients: z.array(zId).min(1).max(LIMITS.groupDmMax - 1),
  name: z.string().trim().max(100).optional(),
});

export const scheduledCreateSchema = z.object({
  content: z.string().max(LIMITS.messageMax).default(""),
  attachments: z.array(zId).max(LIMITS.attachmentsPerMessage).optional(),
  sendAt: z.iso.datetime(),
});

export const notificationSettingSchema = z.object({
  targetId: zId,
  level: z.enum(["default", "all", "mentions", "none"]).optional(),
  muted: z.boolean().optional(),
  muteUntil: z.number().int().nullable().optional(),
  suppressEveryone: z.boolean().optional(),
});

export const emojiNameSchema = z.string().regex(EMOJI_NAME_RE, "emoji_name_invalid");

export const ackSchema = z.object({ messageId: zId.nullable().optional() });

export const settingsSchema = z.record(z.string(), z.unknown());

// ── instance administration ────────────────────────────────────────────────
export const instanceSettingsSchema = z.object({
  registration: z.enum(["open", "invite", "closed"]).optional(),
  serverName: z.string().trim().min(1).max(64).optional(),
  /** KLIPY app key; "" turns GIF search off. */
  gifKey: z.string().trim().max(128).regex(/^[A-Za-z0-9_-]*$/, "invalid_key").optional(),
});

/** The SMTP account for password-reset mail. No `pass`: keep the saved one. */
export const mailSettingsSchema = z
  .object({
    host: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9.-]+$/, "invalid_host"),
    port: z.coerce.number().int().min(1).max(65535),
    user: z.string().trim().min(1).max(200),
    pass: z.string().min(1).max(500).optional(),
    from: z.string().trim().max(200).optional(),
  })
;

// ── favourite GIFs ─────────────────────────────────────────────────────────
/** An absolute http(s) URL, or a file on this server. */
const zGifUrl = z.string().max(2000).regex(/^(https?:\/\/[^\s/]+\/|\/files\/|\/media-proxy\?)\S*$/i, "invalid_url");
export const favoriteGifSchema = z.object({
  url: zGifUrl,
  preview: zGifUrl.nullable().optional(),
  width: z.number().int().min(1).max(10_000).nullable().optional(),
  height: z.number().int().min(1).max(10_000).nullable().optional(),
});
export const favoriteGifRemoveSchema = z.object({ url: z.string().max(2000) });
export const MAX_FAVORITE_GIFS = 500;

// ── soundboard sounds and voice presets ────────────────────────────────────
export const MAX_OWN_SOUNDS = 48;
export const MAX_GUILD_SOUNDS = 96;
export const MAX_SOUND_BYTES = 8 * 1024 * 1024;
export const MAX_OWN_PRESETS = 32;
export const MAX_GUILD_PRESETS = 64;

const zExpressionName = z.string().trim().min(1).max(32);
/** An emoji as text (unicode, maybe with a skin tone or ZWJ sequence). */
const zEmojiText = z.string().trim().min(1).max(32).nullable().optional();
const zFilePath = z.string().max(500).regex(/^\/files\/[^\s?#]+$/, "invalid_url");

export const soundCreateSchema = z.object({
  name: zExpressionName,
  emoji: zEmojiText,
  image: zFilePath.nullable().optional(),
  guildId: zId.optional(),
});
export const soundUpdateSchema = z.object({
  name: zExpressionName.optional(),
  emoji: zEmojiText,
  image: zFilePath.nullable().optional(),
});

/** Copy a sound to your own (guildId null) or to a server you're in. */
export const soundCopySchema = z.object({ guildId: zId.nullable() });
/** A section's new order: all of its sound ids, first to last. */
export const soundOrderSchema = z.object({ guildId: zId.nullable(), ids: z.array(zId).max(200) });

export const voiceParamsSchema = z.object({
  pitch: z.number().min(-12).max(12),
  robot: z.number().min(0).max(1),
  robotHz: z.number().min(20).max(400),
  drive: z.number().min(0).max(1),
  lowpass: z.number().min(300).max(20_000),
  highpass: z.number().min(20).max(3000),
  echo: z.number().min(0).max(1),
  echoMs: z.number().min(40).max(900),
  reverb: z.number().min(0).max(1),
  room: z.number().min(0.2).max(6),
  tremolo: z.number().min(0).max(1),
  tremoloHz: z.number().min(0.5).max(20),
  trim: z.number().min(0.02).max(8),
});
export const voicePresetCreateSchema = z.object({ name: zExpressionName, emoji: zEmojiText, params: voiceParamsSchema, guildId: zId.optional() });
export const voicePresetUpdateSchema = z.object({ name: zExpressionName.optional(), emoji: zEmojiText, params: voiceParamsSchema.optional() });
export const adminFlagSchema = z.object({ value: z.boolean() });
export const adminTransferSchema = z.object({ userId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/) });

/** Flatten zod issues into `{ "path.to.field": "code_or_message" }`. */
export function issuesToFields(issues: readonly { path: readonly PropertyKey[]; message: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const key = i.path.map(String).join(".") || "_";
    if (!out[key]) out[key] = i.message;
  }
  return out;
}

export const RADIO_MAX_ITEMS = 50;
export const RADIO_MAX_SECONDS = 20 * 60;
export const RADIO_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const RADIO_MAX_LINKS = 20;
const zHttpUrl = z.string().trim().max(2000).regex(/^https?:\/\/\S+$/i, "invalid_url");
export const radioItemCreateSchema = z
  .object({
    kind: z.enum(["file", "link"]),
    title: z.string().trim().min(1).max(200),
    duration: z.number().min(1).max(RADIO_MAX_SECONDS),
    url: zHttpUrl.optional(),
  })
  .refine((v) => (v.kind === "link") === !!v.url, { message: "url_required_for_links", path: ["url"] });
export const radioLinkCreateSchema = z.object({ url: zHttpUrl, title: z.string().trim().max(200).optional() });
export const radioSkipSchema = z.object({ itemId: zId });
export const radioStationSchema = z.object({ name: z.string().trim().min(1).max(120), url: zHttpUrl, favicon: zHttpUrl.optional(), uuid: z.string().max(64).optional() });

/** Yandex Music or VK links: shared as cards (no third-party playback exists). */
export function isMusicServiceLink(url: string): "yandex" | "vk" | null {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^www\.|^m\./, "");
    if (/^music\.yandex\.(ru|com|by|kz|uz)$/.test(h)) return "yandex";
    if (/^(vk\.com|vk\.ru|vkvideo\.ru|vk\.cc)$/.test(h)) return "vk";
  } catch {
    /* not a URL */
  }
  return null;
}
