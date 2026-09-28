import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSIONS,
  Permission,
  computeBasePermissions,
  computeChannelPermissions,
  extractMentions,
  extractUrls,
  hasPerm,
  isUlid,
  parseReactionKey,
  reactionKey,
  sortGuildChannels,
  ulid,
  ulidBound,
  ulidTime,
  type ChannelDTO,
  type PermContext,
} from "./index";

describe("ulid", () => {
  it("is 26 chars, valid, and time-decodable", () => {
    const now = Date.now();
    const id = ulid(now);
    expect(id).toHaveLength(26);
    expect(isUlid(id)).toBe(true);
    expect(ulidTime(id)).toBe(now);
  });

  it("is strictly monotonic within one millisecond", () => {
    const t = 1_800_000_000_000;
    const ids = Array.from({ length: 500 }, () => ulid(t));
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("bounds bracket ids of that time", () => {
    // Later than any timestamp used above (the generator is monotonic).
    const t = 2_000_000_000_000;
    const id = ulid(t);
    expect(ulidBound(t) <= id).toBe(true);
    expect(ulidBound(t, true) >= id).toBe(true);
  });
});

describe("permissions", () => {
  const guildId = ulid();
  const owner = ulid();
  const alice = ulid();
  const mod = ulid();
  const ctx: PermContext = {
    guildId,
    ownerId: owner,
    roles: [
      { id: guildId, position: 0, permissions: (Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES | Permission.CONNECT | Permission.SPEAK).toString() },
      { id: mod, position: 5, permissions: Permission.MANAGE_MESSAGES.toString() },
    ],
  };

  it("owner has everything", () => {
    expect(computeBasePermissions(ctx, owner, [])).toBe(ALL_PERMISSIONS);
    expect(computeChannelPermissions(ctx, owner, [], [{ id: guildId, type: "role", allow: "0", deny: Permission.VIEW_CHANNEL.toString() }])).toBe(ALL_PERMISSIONS);
  });

  it("everyone base + role bits", () => {
    const bits = computeBasePermissions(ctx, alice, [mod]);
    expect(hasPerm(bits, Permission.SEND_MESSAGES)).toBe(true);
    expect(hasPerm(bits, Permission.MANAGE_MESSAGES)).toBe(true);
    expect(hasPerm(bits, Permission.BAN_MEMBERS)).toBe(false);
  });

  it("private channel: @everyone deny view, role allow", () => {
    const overwrites = [
      { id: guildId, type: "role" as const, allow: "0", deny: Permission.VIEW_CHANNEL.toString() },
      { id: mod, type: "role" as const, allow: Permission.VIEW_CHANNEL.toString(), deny: "0" },
    ];
    expect(computeChannelPermissions(ctx, alice, [], overwrites)).toBe(0n);
    expect(hasPerm(computeChannelPermissions(ctx, alice, [mod], overwrites), Permission.SEND_MESSAGES)).toBe(true);
  });

  it("member overwrite beats role overwrite", () => {
    const overwrites = [
      { id: mod, type: "role" as const, allow: "0", deny: Permission.SEND_MESSAGES.toString() },
      { id: alice, type: "member" as const, allow: Permission.SEND_MESSAGES.toString(), deny: "0" },
    ];
    expect(hasPerm(computeChannelPermissions(ctx, alice, [mod], overwrites), Permission.SEND_MESSAGES)).toBe(true);
  });

  it("timeout strips everything but reading", () => {
    const bits = computeChannelPermissions(ctx, alice, [mod], [], Date.now() + 60_000);
    expect(hasPerm(bits, Permission.VIEW_CHANNEL)).toBe(true);
    expect(hasPerm(bits, Permission.SEND_MESSAGES)).toBe(false);
  });

  it("no send → no attach/mention-everyone", () => {
    const withAttach = { ...ctx, roles: [{ id: guildId, position: 0, permissions: (Permission.VIEW_CHANNEL | Permission.ATTACH_FILES).toString() }] };
    expect(hasPerm(computeChannelPermissions(withAttach, alice, [], []), Permission.ATTACH_FILES)).toBe(false);
  });
});

describe("mentions", () => {
  const u = ulid();
  const r = ulid();
  it("extracts users, roles, everyone; ignores code", () => {
    const m = extractMentions(`hi <@${u}> and <@&${r}> @everyone \`<@${ulid()}>\``);
    expect(m.users).toEqual([u]);
    expect(m.roles).toEqual([r]);
    expect(m.everyone).toBe(true);
  });
  it("does not treat emails as @everyone", () => {
    expect(extractMentions("mail me@everyone.com").everyone).toBe(false);
  });
  it("urls skip <suppressed> links", () => {
    expect(extractUrls("see https://a.com/x, <https://b.com> and https://c.com.")).toEqual(["https://a.com/x", "https://c.com"]);
  });
  it("reaction keys round-trip", () => {
    const id = ulid();
    expect(parseReactionKey(reactionKey({ name: "party", id }))).toEqual({ name: "party", id });
    expect(parseReactionKey("🔥")).toEqual({ name: "🔥", id: null });
  });
});

describe("sortGuildChannels", () => {
  const ch = (p: Partial<ChannelDTO>): ChannelDTO => ({
    id: ulid(),
    type: "text",
    guildId: "g",
    parentId: null,
    name: "x",
    topic: null,
    position: 0,
    nsfw: false,
    slowmode: 0,
    bitrate: 64000,
    userLimit: 0,
    lastMessageId: null,
    lastPinAt: null,
    overwrites: [],
    recipients: [],
    ownerId: null,
    icon: null,
    thread: null,
    createdAt: "",
    ...p,
  });
  it("groups under categories, text before voice", () => {
    const cat = ch({ type: "category", position: 0, name: "cat" });
    const voice = ch({ type: "voice", parentId: cat.id, position: 0, name: "v" });
    const text = ch({ type: "text", parentId: cat.id, position: 5, name: "t" });
    const loose = ch({ type: "text", position: 1, name: "loose" });
    const groups = sortGuildChannels([voice, cat, text, loose]);
    expect(groups[0].category).toBeNull();
    expect(groups[0].channels.map((c) => c.name)).toEqual(["loose"]);
    expect(groups[1].channels.map((c) => c.name)).toEqual(["t", "v"]);
  });
});
