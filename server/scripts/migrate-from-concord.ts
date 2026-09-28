// Imports an old Concord database (and its uploads) into Nova.
//
//   npm run migrate:concord -- --from /opt/concord/server/prisma/dev.db \
//                              --uploads /opt/concord/server/uploads [--dry-run] [--force]
//
// Moves: accounts (passwords keep working — both use bcrypt), friends and
// pending requests, servers with roles/permissions/members/nicknames,
// categories/channels/threads, DMs and group DMs, the full message history
// (replies, pins, edits, polls with votes, reactions, attachments, call logs),
// custom emoji, invites, read positions and future scheduled messages.
// Concord's plain-text @user / #channel / :emoji: become real mentions.
// Not moved: sessions (everyone signs in once more), stickers, link previews
// (rebuilt from the URLs), per-app settings.
//
// Writes into an empty Nova database; --force merges into a populated one
// (accounts whose email already exists are linked to the existing Nova user).
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { ALL_PERMISSIONS, MessageType, RelationshipType, USERNAME_RE, UserFlags, extractMentions, hexToColor } from "@nova/shared";
import type { Prisma } from "@prisma/client";
import { prisma, tuneSqlite } from "../src/db";
import { imageSize, processImage, publicUrl, resolveStorage, sanitizeFilename, typeFromName, type ImageKind } from "../src/lib/files";

// ── arguments ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const FROM = opt("from");
const UPLOADS = opt("uploads") ? resolve(opt("uploads")!) : null;
const DRY = argv.includes("--dry-run");
const FORCE = argv.includes("--force");
if (!FROM || !existsSync(FROM)) {
  console.error("usage: migrate-from-concord --from <concord dev.db> [--uploads <concord uploads dir>] [--dry-run] [--force]");
  process.exit(1);
}

const old = new DatabaseSync(FROM, { readOnly: true });
type Row = Record<string, unknown>;
const tableExists = (name: string) => !!old.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const rows = <T = Row>(table: string, order = "createdAt"): T[] => {
  if (!tableExists(table)) return [];
  const cols = old.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
  const by = cols.some((c) => c.name === order) ? ` ORDER BY "${order}" ASC` : "";
  return old.prepare(`SELECT * FROM "${table}"${by}`).all() as T[];
};

const stats: Record<string, number> = {};
const bump = (k: string, n = 1) => (stats[k] = (stats[k] ?? 0) + n);

// ── helpers ───────────────────────────────────────────────────────────────────
/** Prisma stores SQLite DateTime as epoch ms; older rows may hold ISO strings. */
function ms(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") return /^\d+$/.test(v) ? Number(v) : Date.parse(v) || Date.now();
  return Date.now();
}
const date = (v: unknown) => new Date(ms(v));
const str = (v: unknown) => (v == null ? null : String(v));

// Time-accurate ULIDs: message ids ARE the ordering/pagination/unread cursor,
// so each one must encode the original createdAt. Same-millisecond ids count
// up from one random start, preserving insertion order.
const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const enc = (n: bigint, len: number) => {
  let s = "";
  for (let i = 0; i < len; i++) {
    s = ENC[Number(n % 32n)] + s;
    n /= 32n;
  }
  return s;
};
const lastAt = new Map<number, bigint>();
function idAt(t: number): string {
  t = Math.max(0, Math.floor(t));
  const prev = lastAt.get(t);
  const r = prev === undefined ? BigInt("0x" + randomBytes(9).toString("hex")) : prev + 1n; // 72 random bits: room to count up
  lastAt.set(t, r);
  return enc(BigInt(t), 10) + enc(r, 16);
}
const upperBound = (t: number) => enc(BigInt(Math.max(0, Math.floor(t))), 10) + "Z".repeat(16);

const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o",
  п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};
function handleFor(name: string, taken: Set<string>): string {
  let base = [...name.toLowerCase()].map((c) => TRANSLIT[c] ?? c).join("");
  base = base.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  base = base.replace(/[^a-z0-9_.]+/g, "_").replace(/\.{2,}/g, ".").replace(/^\.+|\.+$/g, "").replace(/_{2,}/g, "_");
  if (base.replace(/[._]/g, "").length < 2) base = "user";
  base = base.slice(0, 28).replace(/\.+$/, "");
  let cand = base;
  for (let i = 2; taken.has(cand) || !USERNAME_RE.test(cand); i++) cand = `${base}${i}`;
  taken.add(cand);
  return cand;
}

function oldFile(url: string | null): string | null {
  if (!url || !UPLOADS) return null;
  const m = /\/uploads\/(.+)$/.exec(url.split("?")[0]);
  if (!m) return null;
  let rel: string;
  try {
    rel = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  const full = resolve(UPLOADS, rel);
  return full.startsWith(UPLOADS + sep) && existsSync(full) ? full : null;
}

/** Avatars, banners, icons, emoji → normalized WebP in Nova's storage. */
async function importImage(url: string | null, kind: ImageKind): Promise<string | null> {
  if (!url) return null;
  const full = oldFile(url);
  if (!full) {
    if (url.includes("/uploads/")) bump("files missing");
    return null;
  }
  if (DRY) return "/files/dry-run.webp";
  try {
    const { rel } = await processImage(readFileSync(full), kind);
    bump("images");
    return publicUrl(rel);
  } catch {
    bump("images unreadable");
    return null;
  }
}

async function importAttachment(url: string, filename: string, at: number) {
  const full = oldFile(url);
  if (!full) {
    bump("files missing");
    return null;
  }
  const d = new Date(at);
  const rel = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${idAt(at)}/${sanitizeFilename(filename)}`;
  const size = statSync(full).size;
  if (!DRY) {
    const dest = resolveStorage(rel);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(full, dest);
  }
  bump("files copied");
  return { rel, size, full };
}

async function insert<T>(label: string, list: T[], write: (chunk: T[]) => Promise<unknown>) {
  bump(label, list.length);
  if (DRY) return;
  for (let i = 0; i < list.length; i += 400) await write(list.slice(i, i + 400));
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  await tuneSqlite();
  const existingUsers = await prisma.user.count();
  if (existingUsers && !FORCE) {
    console.error(`✖ Nova already has ${existingUsers} account(s). Run on a fresh database, or pass --force to merge.`);
    process.exit(1);
  }
  console.log(`▶ Concord → Nova${DRY ? " (dry run — nothing is written)" : ""}\n  from ${FROM}\n  uploads ${UPLOADS ?? "(none — files are skipped)"}`);

  // ── users ──
  const userMap = new Map<string, string>();
  const oldUsername = new Map<string, string>(); // old id → old username (for @mentions)
  const taken = new Set((await prisma.user.findMany({ select: { username: true } })).map((u) => u.username));
  const newUsers: Prisma.UserCreateManyInput[] = [];
  const oldUsers = rows("User");
  for (const [i, u] of oldUsers.entries()) {
    const email = String(u.email).trim().toLowerCase();
    oldUsername.set(String(u.id), String(u.username));
    const existing = FORCE ? await prisma.user.findUnique({ where: { email }, select: { id: true } }) : null;
    if (existing) {
      userMap.set(String(u.id), existing.id);
      bump("accounts linked");
      continue;
    }
    const id = idAt(ms(u.createdAt));
    userMap.set(String(u.id), id);
    const username = handleFor(String(u.username), taken);
    const display = str(u.displayName)?.trim() || (username !== String(u.username) ? String(u.username) : null);
    const choice = String(u.presenceChoice ?? "ONLINE").toLowerCase();
    newUsers.push({
      id,
      username,
      email,
      passwordHash: String(u.passwordHash),
      displayName: display?.slice(0, 32) ?? null,
      avatar: await importImage(str(u.avatarUrl), "avatar"),
      banner: await importImage(str(u.bannerUrl), "banner"),
      accentColor: u.accentColor ? hexToColor(String(u.accentColor)) : null,
      bio: str(u.bio)?.slice(0, 190) ?? null,
      pronouns: str(u.pronouns)?.slice(0, 40) ?? null,
      status: ["online", "idle", "dnd", "invisible"].includes(choice) ? choice : "online",
      customStatusText: str(u.customStatus)?.slice(0, 128) ?? null,
      // The first Concord account administers the instance (as it would have by registering first).
      flags: !existingUsers && i === 0 ? UserFlags.INSTANCE_ADMIN : 0,
      createdAt: date(u.createdAt),
    });
  }
  await insert("accounts", newUsers, (c) => prisma.user.createMany({ data: c }));
  const U = (oldId: unknown) => userMap.get(String(oldId));

  // ── friends ──
  const rels: { userId: string; targetId: string; type: number; since: Date }[] = [];
  const relSeen = new Set<string>();
  const addRel = (a: string, b: string, type: number, since: Date) => {
    if (a === b || relSeen.has(`${a}:${b}`)) return;
    relSeen.add(`${a}:${b}`);
    rels.push({ userId: a, targetId: b, type, since });
  };
  for (const f of rows("Friendship")) {
    const a = U(f.requesterId);
    const b = U(f.addresseeId);
    if (!a || !b) continue;
    const since = date(f.createdAt);
    if (String(f.status) === "ACCEPTED") {
      addRel(a, b, RelationshipType.FRIEND, since);
      addRel(b, a, RelationshipType.FRIEND, since);
    } else {
      addRel(a, b, RelationshipType.OUTGOING, since);
      addRel(b, a, RelationshipType.INCOMING, since);
    }
  }
  await insert("relationships", rels, (c) => prisma.relationship.createMany({ data: c }));

  // ── guilds, roles, members ──
  const guildMap = new Map<string, string>();
  const roleMap = new Map<string, string>();
  const memberGuild = new Map<string, { guildId: string; userId: string }>(); // old GuildMember.id →
  const guildMembers = new Map<string, Set<string>>(); // new guild id → new user ids
  const guildRows = rows("Guild");
  const newGuilds = [];
  for (const g of guildRows) {
    const ownerId = U(g.ownerId);
    if (!ownerId) continue;
    const id = idAt(ms(g.createdAt));
    guildMap.set(String(g.id), id);
    newGuilds.push({
      id,
      name: String(g.name).slice(0, 100),
      icon: await importImage(str(g.iconUrl), "icon"),
      banner: await importImage(str(g.bannerUrl), "guild_banner"),
      description: str(g.description)?.slice(0, 300) ?? null,
      ownerId,
      createdAt: date(g.createdAt),
    });
  }
  await insert("servers", newGuilds, (c) => prisma.guild.createMany({ data: c }));
  const G = (oldId: unknown) => guildMap.get(String(oldId));

  const newRoles = [];
  const byGuild = new Map<string, Row[]>();
  for (const r of rows("Role")) {
    const gid = String(r.guildId);
    if (!byGuild.has(gid)) byGuild.set(gid, []);
    byGuild.get(gid)!.push(r);
  }
  for (const [oldGid, list] of byGuild) {
    const guildId = G(oldGid);
    if (!guildId) continue;
    let everyone = false;
    const ranked = list.filter((r) => !r.isDefault).sort((a, b) => Number(a.position) - Number(b.position));
    for (const r of list.filter((r) => r.isDefault)) {
      roleMap.set(String(r.id), guildId);
      everyone = true;
      newRoles.push({ id: guildId, guildId, name: "@everyone", color: 0, permissions: (BigInt(String(r.permissions || "0")) & ALL_PERMISSIONS).toString(), position: 0, createdAt: date(r.createdAt) });
    }
    if (!everyone) newRoles.push({ id: guildId, guildId, name: "@everyone", color: 0, permissions: "0", position: 0, createdAt: new Date() });
    ranked.forEach((r, i) => {
      const id = idAt(ms(r.createdAt));
      roleMap.set(String(r.id), id);
      const color = String(r.color ?? "").toLowerCase();
      newRoles.push({
        id,
        guildId,
        name: String(r.name).slice(0, 100),
        color: !color || color === "#99aab5" ? 0 : hexToColor(color),
        permissions: (BigInt(String(r.permissions || "0")) & ALL_PERMISSIONS).toString(),
        position: i + 1,
        hoist: !!r.hoist,
        mentionable: !!r.mentionable,
        createdAt: date(r.createdAt),
      });
    });
  }
  await insert("roles", newRoles, (c) => prisma.role.createMany({ data: c }));

  const newMembers: { guildId: string; userId: string; nick: string | null; joinedAt: Date }[] = [];
  for (const m of rows("GuildMember", "joinedAt")) {
    const guildId = G(m.guildId);
    const userId = U(m.userId);
    if (!guildId || !userId) continue;
    const set = guildMembers.get(guildId) ?? new Set();
    guildMembers.set(guildId, set);
    if (set.has(userId)) continue;
    set.add(userId);
    memberGuild.set(String(m.id), { guildId, userId });
    newMembers.push({ guildId, userId, nick: str(m.nickname)?.slice(0, 32) ?? null, joinedAt: date(m.joinedAt) });
  }
  for (const g of newGuilds) {
    // Owners are always members.
    const set = guildMembers.get(g.id) ?? new Set();
    guildMembers.set(g.id, set);
    if (!set.has(g.ownerId)) {
      set.add(g.ownerId);
      newMembers.push({ guildId: g.id, userId: g.ownerId, nick: null, joinedAt: g.createdAt });
    }
  }
  await insert("members", newMembers, (c) => prisma.member.createMany({ data: c }));

  const memberRoles: { guildId: string; userId: string; roleId: string }[] = [];
  if (tableExists("_GuildMemberToRole")) {
    for (const r of old.prepare('SELECT "A" AS member, "B" AS role FROM "_GuildMemberToRole"').all() as { member: string; role: string }[]) {
      const m = memberGuild.get(String(r.member));
      const roleId = roleMap.get(String(r.role));
      if (m && roleId && roleId !== m.guildId) memberRoles.push({ ...m, roleId });
    }
  }
  await insert("role assignments", memberRoles, (c) => prisma.memberRole.createMany({ data: c }));

  // ── emoji ──
  const emojiByGuild = new Map<string, Map<string, { id: string; animated: boolean }>>();
  const newEmojis = [];
  for (const e of rows("GuildEmoji")) {
    const guildId = G(e.guildId);
    if (!guildId) continue;
    const name = String(e.name).replace(/[^A-Za-z0-9_]/g, "_").slice(0, 32);
    const map = emojiByGuild.get(guildId) ?? new Map();
    emojiByGuild.set(guildId, map);
    if (name.length < 2 || map.has(name.toLowerCase())) continue;
    const path = await importImage(str(e.url), "emoji");
    if (!path) continue;
    const animated = /\.gif($|\?)/i.test(String(e.url));
    const id = idAt(ms(e.createdAt));
    map.set(name.toLowerCase(), { id, animated });
    newEmojis.push({ id, guildId, name, path, animated, createdAt: date(e.createdAt) });
  }
  await insert("emoji", newEmojis, (c) => prisma.emoji.createMany({ data: c }));
  if (rows("GuildSticker").length) bump("stickers skipped", rows("GuildSticker").length);

  // ── channels ──
  const channelMap = new Map<string, string>();
  const channelGuild = new Map<string, string | null>(); // new channel id → new guild id
  const oldChannels = rows("Channel");
  const TYPE: Record<string, string> = { TEXT: "text", VOICE: "voice", CATEGORY: "category", ANNOUNCEMENT: "announcement", FORUM: "text", STAGE: "voice", THREAD: "thread" };
  for (const c of oldChannels) channelMap.set(String(c.id), idAt(ms(c.createdAt)));
  const C = (oldId: unknown) => (oldId == null ? null : channelMap.get(String(oldId)) ?? null);

  const dmMembers = new Map<string, string[]>(); // old channel id → new user ids
  if (tableExists("_DMParticipants")) {
    for (const r of old.prepare('SELECT "A" AS channel, "B" AS user FROM "_DMParticipants"').all() as { channel: string; user: string }[]) {
      const uid = U(r.user);
      if (!uid) continue;
      const list = dmMembers.get(String(r.channel)) ?? [];
      if (!list.includes(uid)) list.push(uid);
      dmMembers.set(String(r.channel), list);
    }
  }

  const newChannels: Prisma.ChannelCreateManyInput[] = [];
  const recipients: { channelId: string; userId: string }[] = [];
  const channelNames = new Map<string, Map<string, string>>(); // guild → lower name → channel id
  for (const c of oldChannels) {
    const id = C(c.id)!;
    const guildId = c.guildId ? G(c.guildId) : null;
    if (c.guildId && !guildId) continue;
    const created = date(c.createdAt);
    if (!guildId) {
      const members = dmMembers.get(String(c.id)) ?? [];
      if (members.length < 2) {
        bump("empty DMs skipped");
        continue;
      }
      const group = members.length > 2;
      newChannels.push({ id, type: group ? "group_dm" : "dm", name: group ? String(c.name ?? "").slice(0, 100) : "", ownerId: group ? members[0] : null, createdAt: created });
      for (const userId of members) recipients.push({ channelId: id, userId });
      channelGuild.set(id, null);
      continue;
    }
    const type = TYPE[String(c.type)] ?? "text";
    const name = String(c.name ?? "channel").slice(0, 100);
    newChannels.push({
      id,
      type,
      guildId,
      parentId: C(c.parentId),
      name,
      topic: str(c.topic)?.slice(0, 1024) ?? null,
      position: Number(c.position ?? 0),
      slowmode: Math.min(21_600, Number(c.slowmode ?? 0)),
      bitrate: Math.min(510_000, Math.max(8_000, Number(c.bitrate ?? 96_000))),
      userLimit: Math.min(99, Number(c.userLimit ?? 0)),
      createdAt: created,
    });
    channelGuild.set(id, guildId);
    if (type !== "category" && type !== "thread") {
      const names = channelNames.get(guildId) ?? new Map();
      channelNames.set(guildId, names);
      if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), id);
    }
  }
  const valid = new Set(newChannels.map((c) => c.id));
  for (const c of newChannels) if (c.parentId && !valid.has(c.parentId)) c.parentId = null;
  await insert("channels", newChannels, (c) => prisma.channel.createMany({ data: c }));
  await insert("DM recipients", recipients, (c) => prisma.channelRecipient.createMany({ data: c }));

  // Guild system channel: first text channel by position.
  if (!DRY) {
    for (const g of newGuilds) {
      const first = newChannels.filter((c) => c.guildId === g.id && c.type === "text").sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0];
      if (first) await prisma.guild.update({ where: { id: g.id }, data: { systemChannelId: first.id } });
    }
  }

  // ── messages ──
  const oldMessages = rows("Message");
  const msgMap = new Map<string, string>();
  for (const m of oldMessages) msgMap.set(String(m.id), idAt(ms(m.createdAt)));
  const lastInChannel = new Map<string, string>();
  const threadCount = new Map<string, number>();
  const threadStarter = new Map<string, { messageId: string; authorId: string }>();
  const userNamesFor = (guildId: string | null, channelId: string): Map<string, string | null> => {
    const ids = guildId ? [...(guildMembers.get(guildId) ?? [])] : recipients.filter((r) => r.channelId === channelId).map((r) => r.userId);
    const byName = new Map<string, string | null>();
    const reverse = new Map([...userMap].map(([o, n]) => [n, o]));
    for (const id of ids) {
      const name = oldUsername.get(reverse.get(id) ?? "")?.toLowerCase();
      if (name) byName.set(name, byName.has(name) ? null : id); // ambiguous names stay text
    }
    return byName;
  };
  const nameCache = new Map<string, Map<string, string | null>>();

  /** Concord stored plain @name / #channel / :emoji: — turn them into Nova tokens (outside code). */
  function convert(content: string, guildId: string | null, channelId: string): string {
    const key = guildId ?? channelId;
    if (!nameCache.has(key)) nameCache.set(key, userNamesFor(guildId, channelId));
    const users = nameCache.get(key)!;
    const chans = guildId ? channelNames.get(guildId) : undefined;
    const emojis = guildId ? emojiByGuild.get(guildId) : undefined;
    return content
      .split(/(```[\s\S]*?```|`[^`\n]+`)/)
      .map((part, i) => {
        if (i % 2) return part;
        let out = part.replace(/(^|[^\w<@])@([\p{L}\p{N}_.]+)/gu, (all, pre: string, raw: string) => {
          const name = raw.replace(/\.+$/, "");
          const id = users.get(name.toLowerCase());
          return id ? `${pre}<@${id}>${raw.slice(name.length)}` : all;
        });
        if (chans) out = out.replace(/(^|[^\w&<])#([\p{L}\p{N}_-]+)/gu, (all, pre: string, name: string) => (chans.get(name.toLowerCase()) ? `${pre}<#${chans.get(name.toLowerCase())}>` : all));
        if (emojis) out = out.replace(/(^|[^\w<]):([A-Za-z0-9_]{2,32}):/g, (all, pre: string, name: string) => {
          const e = emojis.get(name.toLowerCase());
          return e ? `${pre}<${e.animated ? "a" : ""}:${name}:${e.id}>` : all;
        });
        return out;
      })
      .join("");
  }

  const newMessages: Prisma.MessageCreateManyInput[] = [];
  const newAttachments: Prisma.AttachmentCreateManyInput[] = [];
  const pollVotes: { messageId: string; answerId: string; userId: string }[] = [];
  const oldAtts = new Map<string, Row[]>();
  for (const a of rows("Attachment", "id")) {
    const list = oldAtts.get(String(a.messageId)) ?? [];
    list.push(a);
    oldAtts.set(String(a.messageId), list);
  }
  for (const m of oldMessages) {
    const id = msgMap.get(String(m.id))!;
    const channelId = C(m.channelId);
    const authorId = U(m.authorId);
    if (!channelId || !authorId || !valid.has(channelId)) {
      bump("messages skipped");
      continue;
    }
    const guildId = channelGuild.get(channelId) ?? null;
    const created = ms(m.createdAt);
    const replyTo = m.replyToId ? msgMap.get(String(m.replyToId)) : undefined;
    const sys = str(m.systemType);
    let type: number = replyTo ? MessageType.REPLY : MessageType.DEFAULT;
    let content = convert(String(m.content ?? ""), guildId, channelId);
    let meta: string | null = null;
    if (sys === "CALL_ENDED" || sys === "CALL_MISSED") {
      const t = /(\d+):(\d{2})(?::(\d{2}))?/.exec(content);
      const durationSec = t ? (t[3] ? Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]) : Number(t[1]) * 60 + Number(t[2])) : 0;
      type = MessageType.CALL;
      meta = JSON.stringify({ participants: [authorId], endedAt: new Date(created).toISOString(), durationSec, missed: sys === "CALL_MISSED" });
      content = "";
    }
    let poll: string | null = null;
    if (m.pollJson) {
      try {
        const p = JSON.parse(String(m.pollJson)) as { question: string; options: { id: string; label: string }[]; votes?: Record<string, string[]>; multi?: boolean };
        const answerOf = new Map(p.options.map((o, i) => [String(o.id), String(i + 1)]));
        poll = JSON.stringify({
          question: String(p.question).slice(0, 300),
          allowMultiselect: !!p.multi,
          expiresAt: null,
          finalized: false,
          answers: p.options.slice(0, 10).map((o, i) => ({ id: String(i + 1), text: String(o.label).slice(0, 55), emoji: null })),
        });
        for (const [optId, voters] of Object.entries(p.votes ?? {})) {
          const answerId = answerOf.get(optId);
          for (const v of voters) {
            const userId = U(v);
            if (answerId && userId && Number(answerId) <= 10) pollVotes.push({ messageId: id, answerId, userId });
          }
        }
      } catch {
        bump("polls unreadable");
      }
    }
    const threadId = m.threadId ? C(m.threadId) : null;
    if (threadId && valid.has(threadId)) threadStarter.set(threadId, { messageId: id, authorId });
    const mentions = extractMentions(content);
    newMessages.push({
      id,
      channelId,
      authorId,
      type,
      content,
      searchText: content.toLowerCase().replace(/ё/g, "е"), // = services/messages normalizeSearch
      replyToId: replyTo ?? null,
      pinned: !!m.pinned,
      mentions: JSON.stringify(mentions.users),
      mentionRoles: JSON.stringify(mentions.roles),
      mentionEveryone: mentions.everyone || mentions.here,
      meta,
      poll,
      threadId: threadId && valid.has(threadId) ? threadId : null,
      editedAt: m.editedAt ? date(m.editedAt) : null,
      createdAt: new Date(created),
    });
    lastInChannel.set(channelId, id);
    if (channelGuild.get(channelId) !== undefined) threadCount.set(channelId, (threadCount.get(channelId) ?? 0) + 1);

    for (const a of oldAtts.get(String(m.id)) ?? []) {
      const filename = String(a.filename ?? "file");
      const file = await importAttachment(String(a.url), filename, created);
      if (!file) continue;
      const contentType = str(a.mimeType) || typeFromName(filename) || "application/octet-stream";
      let width = a.width == null ? null : Number(a.width);
      let height = a.height == null ? null : Number(a.height);
      if (contentType.startsWith("image/") && (!width || !height)) {
        const dim = await imageSize(file.full).catch(() => null);
        width = dim?.width ?? null;
        height = dim?.height ?? null;
      }
      newAttachments.push({
        id: idAt(created),
        messageId: id,
        uploaderId: authorId,
        filename: sanitizeFilename(filename),
        path: file.rel,
        size: BigInt(file.size),
        contentType,
        width,
        height,
        createdAt: new Date(created),
      });
    }
  }
  await insert("messages", newMessages, (c) => prisma.message.createMany({ data: c }));
  await insert("attachments", newAttachments, (c) => prisma.attachment.createMany({ data: c }));
  await insert("poll votes", pollVotes, (c) => prisma.pollVote.createMany({ data: c }));

  // Channel bookkeeping: last message, pins, thread starters/counters.
  if (!DRY) {
    for (const [channelId, lastMessageId] of lastInChannel) {
      const starter = threadStarter.get(channelId);
      await prisma.channel.update({
        where: { id: channelId },
        data: {
          lastMessageId,
          ...(starter ? { starterMessageId: starter.messageId, ownerId: starter.authorId, messageCount: threadCount.get(channelId) ?? 0 } : {}),
        },
      });
    }
    for (const [channelId, starter] of threadStarter) {
      if (!lastInChannel.has(channelId)) await prisma.channel.update({ where: { id: channelId }, data: { starterMessageId: starter.messageId, ownerId: starter.authorId } });
    }
    const pinned = newMessages.filter((m) => m.pinned);
    for (const m of pinned) await prisma.channel.update({ where: { id: m.channelId }, data: { lastPinAt: m.createdAt } });
  }

  // ── reactions ──
  const reactions: { messageId: string; userId: string; emoji: string; createdAt: Date }[] = [];
  const reactSeen = new Set<string>();
  const messageGuild = new Map(newMessages.map((m) => [m.id, channelGuild.get(m.channelId) ?? null]));
  for (const r of rows("Reaction")) {
    const messageId = msgMap.get(String(r.messageId));
    const userId = U(r.userId);
    if (!messageId || !userId || !messageGuild.has(messageId)) continue;
    let emoji = String(r.emoji);
    const custom = /^:?([A-Za-z0-9_]{2,32}):?$/.exec(emoji);
    if (custom) {
      const gid = messageGuild.get(messageId);
      const e = gid ? emojiByGuild.get(gid)?.get(custom[1].toLowerCase()) : undefined;
      if (!e) continue;
      emoji = `${custom[1]}:${e.id}`;
    }
    const k = `${messageId}|${userId}|${emoji}`;
    if (reactSeen.has(k)) continue;
    reactSeen.add(k);
    reactions.push({ messageId, userId, emoji, createdAt: date(r.createdAt) });
  }
  await insert("reactions", reactions, (c) => prisma.reaction.createMany({ data: c }));

  // ── read positions: Concord's lastReadAt → Nova's lastReadId. Channels a user
  //    never opened count as read, so the first launch isn't a wall of unread badges.
  const oldRead = new Map<string, number>();
  for (const r of rows("ReadState", "id")) {
    const u = U(r.userId);
    const c = C(r.channelId);
    if (u && c) oldRead.set(`${u}|${c}`, ms(r.lastReadAt));
  }
  const readStates: { userId: string; channelId: string; lastReadId: string }[] = [];
  for (const [channelId, last] of lastInChannel) {
    const guildId = channelGuild.get(channelId);
    const people = guildId ? [...(guildMembers.get(guildId) ?? [])] : recipients.filter((r) => r.channelId === channelId).map((r) => r.userId);
    for (const userId of people) {
      const t = oldRead.get(`${userId}|${channelId}`);
      const bound = t === undefined ? last : upperBound(t);
      readStates.push({ userId, channelId, lastReadId: bound < last ? bound : last });
    }
  }
  await insert("read positions", readStates, (c) => prisma.readState.createMany({ data: c }));

  // ── invites ──
  const invites = [];
  for (const i of rows("Invite")) {
    const guildId = G(i.guildId);
    const code = String(i.code);
    if (!guildId || !/^[A-Za-z0-9-]{2,32}$/.test(code)) continue;
    const expiresAt = i.expiresAt ? date(i.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() < Date.now()) continue;
    invites.push({ code, guildId, inviterId: U(i.inviterId) ?? null, uses: Number(i.uses ?? 0), maxUses: Number(i.maxUses ?? 0), expiresAt, createdAt: date(i.createdAt) });
  }
  await insert("invites", invites, (c) => prisma.invite.createMany({ data: c }));

  // ── scheduled messages still in the future ──
  const scheduled = [];
  for (const s of rows("ScheduledMessage")) {
    const channelId = C(s.channelId);
    const authorId = U(s.authorId);
    if (!channelId || !authorId || !valid.has(channelId) || ms(s.sendAt) < Date.now()) continue;
    scheduled.push({ id: idAt(ms(s.createdAt)), channelId, authorId, content: String(s.content ?? ""), sendAt: date(s.sendAt), createdAt: date(s.createdAt) });
  }
  await insert("scheduled messages", scheduled, (c) => prisma.scheduledMessage.createMany({ data: c }));

  console.log("\n✅ Done" + (DRY ? " (dry run)" : "") + ":");
  for (const [k, v] of Object.entries(stats)) console.log(`   ${k.padEnd(20)} ${v}`);
  const renamed = newUsers.filter((u) => u.username !== oldUsername.get([...userMap].find(([, n]) => n === u.id)?.[0] ?? ""));
  if (renamed.length) {
    console.log("\n   Usernames adapted to Nova's format (a-z 0-9 _ . — sign in with email or the new name):");
    for (const u of renamed) console.log(`     ${oldUsername.get([...userMap].find(([, n]) => n === u.id)?.[0] ?? "")} → ${u.username}`);
  }
  console.log("\n   Everyone signs in again once (sessions are not carried over). Restart the Nova server to load the data.");
}

main()
  .catch((e) => {
    console.error("\n✖ Migration failed:", e);
    console.error("  The Nova database may be partially filled — restore it (or delete data/nova.db and run `npm run db:deploy`) before retrying.");
    process.exitCode = 1;
  })
  .finally(() => {
    old.close();
    void prisma.$disconnect();
  });
