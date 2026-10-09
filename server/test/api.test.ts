// End-to-end API + gateway tests against a real server on a random port.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { io as connectIo, type Socket } from "socket.io-client";
import { Permission, UserFlags, type DispatchEvent, type GuildCreatePayload, type MessageDTO, type ReadyPayload } from "@nova/shared";

let app: FastifyInstance;
let base = "";
let closeIo: () => void = () => {};

beforeAll(async () => {
  const { tuneSqlite } = await import("../src/db");
  await tuneSqlite();
  const { cache } = await import("../src/state/cache");
  await cache.loadAll();
  const { buildApp } = await import("../src/app");
  app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { attachGateway } = await import("../src/gateway");
  const io = attachGateway(app.server, app.log);
  closeIo = () => io.close();
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  closeIo();
  await app?.close();
});

// ── helpers ──────────────────────────────────────────────────────────────────
async function api<T = any>(method: string, path: string, token?: string | null, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* not json */
  }
  return { status: res.status, body: parsed as T };
}

interface Acc {
  id: string;
  token: string;
  refresh: string;
  username: string;
}

async function register(username: string): Promise<Acc> {
  const r = await api("POST", "/api/auth/register", null, { username, email: `${username}@example.com`, password: "correct-horse-battery" });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: r.body.user.id, token: r.body.accessToken, refresh: r.body.refreshToken, username };
}

const sockets: Socket[] = [];
interface Live {
  socket: Socket;
  events: DispatchEvent[];
  ready: ReadyPayload;
  waitFor: <T extends DispatchEvent["t"]>(t: T, pred?: (d: Extract<DispatchEvent, { t: T }>["d"]) => boolean, ms?: number) => Promise<Extract<DispatchEvent, { t: T }>["d"]>;
}

async function live(acc: Acc): Promise<Live> {
  const socket = connectIo(base, { auth: { token: acc.token, platform: "web" }, transports: ["websocket"], forceNew: true });
  sockets.push(socket);
  const events: DispatchEvent[] = [];
  const waiters: { t: string; pred?: (d: any) => boolean; resolve: (d: any) => void }[] = [];
  socket.on("dispatch", (e: DispatchEvent) => {
    events.push(e);
    for (const w of [...waiters]) {
      if (w.t === e.t && (!w.pred || w.pred(e.d))) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(e.d);
      }
    }
  });
  const waitFor: Live["waitFor"] = (t, pred, ms = 5000) =>
    new Promise((resolve, reject) => {
      const hit = events.find((e) => e.t === t && (!pred || pred(e.d as never)));
      if (hit) return resolve(hit.d as never);
      const w = { t, pred: pred as (d: any) => boolean, resolve };
      waiters.push(w);
      setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) {
          waiters.splice(i, 1);
          reject(new Error(`timeout waiting for ${t}`));
        }
      }, ms);
    });
  const ready = (await waitFor("READY")) as ReadyPayload;
  return { socket, events, ready, waitFor };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── tests ────────────────────────────────────────────────────────────────────
let alice: Acc;
let bob: Acc;
let guild: GuildCreatePayload;
let general: string;

describe("auth", () => {
  it("first user becomes instance admin; login by username or email", async () => {
    alice = await register("alice");
    const me = await api("GET", "/api/users/@me", alice.token);
    expect(me.body.flags & UserFlags.INSTANCE_ADMIN).toBeTruthy();
    bob = await register("bob");
    const bobMe = await api("GET", "/api/users/@me", bob.token);
    expect(bobMe.body.flags & UserFlags.INSTANCE_ADMIN).toBeFalsy();

    expect((await api("POST", "/api/auth/login", null, { login: "ALICE", password: "correct-horse-battery" })).status).toBe(200);
    expect((await api("POST", "/api/auth/login", null, { login: "alice@example.com", password: "correct-horse-battery" })).status).toBe(200);
    const bad = await api("POST", "/api/auth/login", null, { login: "alice", password: "nope-nope-nope" });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe("invalid_credentials");
  });

  it("rejects duplicate usernames and bad input with field errors", async () => {
    const dup = await api("POST", "/api/auth/register", null, { username: "alice", email: "x@example.com", password: "correct-horse-battery" });
    expect(dup.status).toBe(409);
    const bad = await api("POST", "/api/auth/register", null, { username: "A B", email: "nope", password: "1" });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.error.fields)).toEqual(expect.arrayContaining(["username", "email", "password"]));
  });

  it("refresh issues a new access token", async () => {
    const r = await api("POST", "/api/auth/refresh", null, { refreshToken: alice.refresh });
    expect(r.status).toBe(200);
    expect((await api("GET", "/api/users/@me", r.body.accessToken)).status).toBe(200);
  });

  it("revoked sessions stop working immediately", async () => {
    const extra = await api("POST", "/api/auth/login", null, { login: "bob", password: "correct-horse-battery" });
    const token = extra.body.accessToken;
    expect((await api("GET", "/api/users/@me", token)).status).toBe(200);
    const sessions = await api("GET", "/api/users/@me/sessions", bob.token);
    const other = sessions.body.find((s: { current: boolean }) => !s.current && s.id);
    expect(other).toBeTruthy();
    expect((await api("DELETE", `/api/users/@me/sessions/${other.id}`, bob.token)).status).toBe(204);
    expect((await api("GET", "/api/users/@me", token)).status).toBe(401);
    expect((await api("GET", "/api/users/@me", bob.token)).status).toBe(200);
  });
});

describe("guilds, invites, messages", () => {
  let aLive: Live;
  let bLive: Live;

  it("creates a guild from a template and delivers it over the gateway", async () => {
    aLive = await live(alice);
    const r = await api("POST", "/api/guilds", alice.token, { name: "Тестовый сервер", template: "default", locale: "ru" });
    expect(r.status).toBe(201);
    guild = r.body;
    const text = guild.channels.find((c) => c.type === "text")!;
    expect(text.name).toBe("общий");
    expect(guild.channels.some((c) => c.type === "voice")).toBe(true);
    general = text.id;
    await aLive.waitFor("GUILD_CREATE", (g) => g.id === guild.id);
  });

  it("guild ids can't be joined without an invite", async () => {
    // No open-join route exists; channel access is denied to non-members.
    expect((await api("GET", `/api/channels/${general}/messages`, bob.token)).status).toBe(404);
    expect((await api("GET", `/api/guilds/${guild.id}`, bob.token)).status).toBe(404);
  });

  it("invite: public preview, then join", async () => {
    bLive = await live(bob);
    const inv = await api("POST", `/api/guilds/${guild.id}/invites`, alice.token, { maxAge: 3600, maxUses: 0 });
    expect(inv.status).toBe(201);
    const preview = await api("GET", `/api/invites/${inv.body.code}`);
    expect(preview.body.guild.name).toBe("Тестовый сервер");
    expect(preview.body.guild.memberCount).toBe(1);
    const join = await api("POST", `/api/invites/${inv.body.code}`, bob.token);
    expect(join.status).toBe(200);
    await bLive.waitFor("GUILD_CREATE", (g) => g.id === guild.id);
    await aLive.waitFor("GUILD_MEMBER_ADD", (m) => m.userId === bob.id);
    // System "joined" message lands in the system channel.
    await aLive.waitFor("MESSAGE_CREATE", (m) => m.channelId === general && m.type === 7 && m.author.id === bob.id);
  });

  it("messages are idempotent by nonce and fan out live", async () => {
    const body = { content: "Привет, **мир**!", nonce: "n-1" };
    const first = await api<MessageDTO>("POST", `/api/channels/${general}/messages`, bob.token, body);
    expect(first.status).toBe(201);
    const again = await api<MessageDTO>("POST", `/api/channels/${general}/messages`, bob.token, body);
    expect(again.body.id).toBe(first.body.id);
    const got = await aLive.waitFor("MESSAGE_CREATE", (m) => m.id === first.body.id);
    expect(got.nonce).toBe("n-1");
    const hist = await api<MessageDTO[]>("GET", `/api/channels/${general}/messages?limit=50`, alice.token);
    expect(hist.body.filter((m) => m.nonce === "n-1")).toHaveLength(1);
  });

  it("mentions bump the mention counter; ack clears it on every device", async () => {
    const m = await api<MessageDTO>("POST", `/api/channels/${general}/messages`, alice.token, { content: `эй <@${bob.id}>` });
    expect(m.body.mentions).toEqual([bob.id]);
    const { prisma } = await import("../src/db");
    const rs = await prisma.readState.findUnique({ where: { userId_channelId: { userId: bob.id, channelId: general } } });
    expect(rs?.mentionCount).toBe(1);
    await api("POST", `/api/channels/${general}/ack`, bob.token, { messageId: m.body.id });
    await bLive.waitFor("MESSAGE_ACK", (a) => a.channelId === general && a.mentionCount === 0);
  });

  it("members can't delete others' messages; the owner can", async () => {
    const own = await api<MessageDTO>("POST", `/api/channels/${general}/messages`, alice.token, { content: "owner msg" });
    expect((await api("DELETE", `/api/channels/${general}/messages/${own.body.id}`, bob.token)).status).toBe(403);
    const bobs = await api<MessageDTO>("POST", `/api/channels/${general}/messages`, bob.token, { content: "bob msg" });
    expect((await api("DELETE", `/api/channels/${general}/messages/${bobs.body.id}`, alice.token)).status).toBe(204);
    await bLive.waitFor("MESSAGE_DELETE", (d) => d.id === bobs.body.id);
  });

  it("edits, reactions and pins", async () => {
    const msg = await api<MessageDTO>("POST", `/api/channels/${general}/messages`, bob.token, { content: "typo" });
    const ed = await api<MessageDTO>("PATCH", `/api/channels/${general}/messages/${msg.body.id}`, bob.token, { content: "fixed" });
    expect(ed.body.content).toBe("fixed");
    expect(ed.body.editedAt).toBeTruthy();
    expect((await api("PATCH", `/api/channels/${general}/messages/${msg.body.id}`, alice.token, { content: "hijack" })).status).toBe(403);

    const emoji = encodeURIComponent("🔥");
    expect((await api("PUT", `/api/channels/${general}/messages/${msg.body.id}/reactions/${emoji}/@me`, alice.token)).status).toBe(204);
    await bLive.waitFor("MESSAGE_REACTION_ADD", (r) => r.messageId === msg.body.id && r.emoji === "🔥");
    expect((await api("PUT", `/api/channels/${general}/messages/${msg.body.id}/reactions/${encodeURIComponent("notanemoji")}/@me`, alice.token)).status).toBe(400);

    // Pinning needs MANAGE_MESSAGES in guilds.
    expect((await api("PUT", `/api/channels/${general}/pins/${msg.body.id}`, bob.token)).status).toBe(403);
    expect((await api("PUT", `/api/channels/${general}/pins/${msg.body.id}`, alice.token)).status).toBe(204);
    const pins = await api<MessageDTO[]>("GET", `/api/channels/${general}/pins`, bob.token);
    expect(pins.body.map((p) => p.id)).toContain(msg.body.id);
  });

  it("private channels are invisible and unreachable to non-allowed members", async () => {
    const deny = Permission.VIEW_CHANNEL.toString();
    const r = await api("POST", `/api/guilds/${guild.id}/channels`, alice.token, {
      name: "Секретный",
      type: "text",
      overwrites: [{ id: guild.id, type: "role", allow: "0", deny }],
    });
    expect(r.status).toBe(201);
    const secret = r.body.id as string;
    expect(r.body.name).toBe("секретный");
    await aLive.waitFor("CHANNEL_CREATE", (c) => c.id === secret);
    await sleep(200);
    expect(bLive.events.some((e) => e.t === "CHANNEL_CREATE" && e.d.id === secret)).toBe(false);
    expect((await api("GET", `/api/channels/${secret}/messages`, bob.token)).status).toBe(404);
    expect((await api("POST", `/api/channels/${secret}/messages`, bob.token, { content: "sneak" })).status).toBe(404);

    // Granting bob access by member overwrite makes it appear for him live.
    await api("PATCH", `/api/channels/${secret}`, alice.token, {
      overwrites: [
        { id: guild.id, type: "role", allow: "0", deny },
        { id: bob.id, type: "member", allow: deny, deny: "0" },
      ],
    });
    await bLive.waitFor("CHANNEL_CREATE", (c) => c.id === secret);
    expect((await api("GET", `/api/channels/${secret}/messages`, bob.token)).status).toBe(200);
  });

  it("members can't escalate: no roles, no channel management", async () => {
    expect((await api("POST", `/api/guilds/${guild.id}/roles`, bob.token, { name: "admin", permissions: Permission.ADMINISTRATOR.toString() })).status).toBe(403);
    expect((await api("POST", `/api/guilds/${guild.id}/channels`, bob.token, { name: "x" })).status).toBe(403);
    expect((await api("DELETE", `/api/guilds/${guild.id}/members/${alice.id}`, bob.token)).status).toBe(403);
  });

  it("search is case-insensitive for Cyrillic and respects visibility", async () => {
    await api("POST", `/api/channels/${general}/messages`, alice.token, { content: "Ёлка стоит в ЗАЛЕ" });
    await sleep(50);
    const r = await api("GET", `/api/guilds/${guild.id}/messages/search?content=${encodeURIComponent("елка зале")}`, bob.token);
    expect(r.status).toBe(200);
    expect(r.body.messages.map((m: MessageDTO) => m.content)).toContain("Ёлка стоит в ЗАЛЕ");
  });

  it("uploads: images get dimensions + resized variants; html downloads instead of rendering", async () => {
    const png = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 50, b: 90 } } }).png().toBuffer();
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "фото.png");
    const up = await fetch(base + "/api/attachments", { method: "POST", headers: { authorization: `Bearer ${bob.token}` }, body: form });
    expect(up.status).toBe(201);
    const att = await up.json();
    expect(att.width).toBe(800);
    expect(att.contentType).toBe("image/png");

    const msg = await api<MessageDTO>("POST", `/api/channels/${general}/messages`, bob.token, { content: "", attachments: [att.id] });
    expect(msg.status).toBe(201);
    expect(msg.body.attachments[0].id).toBe(att.id);
    // Can't reuse a claimed attachment.
    expect((await api("POST", `/api/channels/${general}/messages`, bob.token, { content: "again", attachments: [att.id] })).status).toBe(400);

    const file = await fetch(base + att.url);
    expect(file.headers.get("content-type")).toBe("image/png");
    const small = await fetch(base + att.url + "?w=100");
    expect(small.headers.get("content-type")).toBe("image/webp");
    const range = await fetch(base + att.url, { headers: { range: "bytes=0-9" } });
    expect(range.status).toBe(206);
    expect((await range.arrayBuffer()).byteLength).toBe(10);

    const html = new FormData();
    html.append("file", new Blob(["<script>alert(1)</script>"], { type: "text/html" }), "evil.html");
    const up2 = await (await fetch(base + "/api/attachments", { method: "POST", headers: { authorization: `Bearer ${bob.token}` }, body: html })).json();
    const served = await fetch(base + up2.url);
    expect(served.headers.get("content-type")).toBe("application/octet-stream");
    expect(served.headers.get("content-disposition")).toMatch(/^attachment/);
  });

  it("voice tokens only for voice channels the user can connect to", async () => {
    const voiceCh = guild.channels.find((c) => c.type === "voice")!;
    const ok = await api("POST", "/api/voice/join", bob.token, { channelId: voiceCh.id });
    expect(ok.status).toBe(200);
    expect(typeof ok.body.token).toBe("string");
    expect(ok.body.rights.mic).toBe(true);
    expect((await api("POST", "/api/voice/join", bob.token, { channelId: general })).status).toBe(400);
  });
});

describe("friends and DMs", () => {
  it("friend request → accept → DM with live delivery", async () => {
    const carol = await register("carol");
    const cLive = await live(carol);
    const aLive2 = await live(alice);
    expect((await api("POST", "/api/users/@me/relationships", carol.token, { username: "alice" })).status).toBe(200);
    await aLive2.waitFor("RELATIONSHIP_ADD", (r) => r.userId === carol.id && r.type === 3);
    expect((await api("PUT", `/api/users/@me/relationships/${carol.id}`, alice.token, {})).status).toBe(200);
    await cLive.waitFor("RELATIONSHIP_ADD", (r) => r.userId === alice.id && r.type === 1);

    const dm = await api("POST", "/api/users/@me/channels", carol.token, { recipientId: alice.id });
    expect(dm.status).toBe(200);
    const sent = await api<MessageDTO>("POST", `/api/channels/${dm.body.id}/messages`, carol.token, { content: "привет!" });
    // The DM was closed for alice — it reopens with the message.
    await aLive2.waitFor("CHANNEL_CREATE", (c) => c.id === dm.body.id);
    await aLive2.waitFor("MESSAGE_CREATE", (m) => m.id === sent.body.id);

    // Blocking stops DMs both ways.
    expect((await api("PUT", `/api/users/@me/relationships/${carol.id}`, alice.token, { type: 2 })).status).toBe(200);
    expect((await api("POST", `/api/channels/${dm.body.id}/messages`, carol.token, { content: "hello?" })).status).toBe(403);
  });

  it("friend requests find people by @handle, old Name#1234 or unique display name", async () => {
    const gleb = await register("gleb");
    const hana = await register("hana");
    const hana2 = await register("hana_two");
    expect((await api("PATCH", "/api/users/@me", hana.token, { displayName: "Ханна Ёлкина" })).status).toBe(200);
    // by handle, any case, with @ and an old discriminator
    const r1 = await api<{ userId: string }>("POST", "/api/users/@me/relationships", gleb.token, { username: "@HANA#4821" });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r1.body.userId).toBe(hana.id);
    await api("DELETE", `/api/users/@me/relationships/${hana.id}`, gleb.token);
    // by display name: case- and ё-insensitive
    const r2 = await api<{ userId: string }>("POST", "/api/users/@me/relationships", gleb.token, { username: "  ханна елкина " });
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect(r2.body.userId).toBe(hana.id);
    // two people with that display name → ask for the handle instead
    expect((await api("PATCH", "/api/users/@me", hana2.token, { displayName: "Ханна Ёлкина" })).status).toBe(200);
    const r3 = await api<{ error: { code: string } }>("POST", "/api/users/@me/relationships", gleb.token, { username: "Ханна Ёлкина" });
    expect(r3.body.error.code).toBe("ambiguous_user");
    const r4 = await api<{ error: { code: string } }>("POST", "/api/users/@me/relationships", gleb.token, { username: "nobody-like-this" });
    expect(r4.body.error.code).toBe("unknown_user");
  });

  it("strangers without a shared guild can't open a DM", async () => {
    const dave = await register("dave");
    const erin = await register("erin");
    expect((await api("POST", "/api/users/@me/channels", dave.token, { recipientId: erin.id })).status).toBe(403);
  });
});

describe("instance admin", () => {
  it("diagnostic logs: long app names and lines are cut, not refused; only admins read them", async () => {
    // The Windows app's name with its user agent is ~170 characters: 1.7.3 refused it, and no log ever arrived.
    const client = "Nova 1.7.3 desktop · Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) @novaclient/1.7.3 Chrome/140.0.7339.249 Electron/38.8.6 Safari/537.36";
    const sent = await api("POST", "/api/diag", bob.token, { client, lines: ["2026-10-08T00:00:00.000Z [voice] join", "x".repeat(5000)] });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect((await api("GET", "/api/admin/diag", bob.token)).status).toBe(403);
    const list = await api<{ userId: string }[]>("GET", "/api/admin/diag", alice.token);
    expect(list.body.some((f) => f.userId === bob.id)).toBe(true);
    const log = await api<{ text: string }>("GET", `/api/admin/diag/${bob.id}`, alice.token);
    expect(log.body.text).toContain("[voice] join");
    expect(log.body.text).toContain("Electron/38");
  });

  it("only instance admins reach /api/admin", async () => {
    expect((await api("GET", "/api/admin/overview", alice.token)).status).toBe(200);
    const denied = await api("GET", "/api/admin/overview", bob.token);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("admin_only");
  });

  it("reset a password, disable and re-enable an account", async () => {
    const hank = await register("hank");
    const reset = await api<{ password: string }>("POST", `/api/admin/users/${hank.id}/password`, alice.token);
    expect(reset.status).toBe(200);
    expect(reset.body.password).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    // the old session is gone, the new password works
    expect((await api("GET", "/api/auth/me", hank.token)).status).toBe(401);
    expect((await api("POST", "/api/auth/login", null, { login: "hank", password: reset.body.password })).status).toBe(200);

    expect((await api("POST", `/api/admin/users/${hank.id}/disabled`, alice.token, { value: true })).status).toBe(200);
    const blocked = await api("POST", "/api/auth/login", null, { login: "hank", password: reset.body.password });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("account_disabled");
    expect((await api("POST", `/api/admin/users/${hank.id}/disabled`, alice.token, { value: false })).status).toBe(200);
    expect((await api("POST", "/api/auth/login", null, { login: "hank", password: reset.body.password })).status).toBe(200);

    // an admin can't lock themselves out
    expect((await api("POST", `/api/admin/users/${alice.id}/disabled`, alice.token, { value: true })).status).toBe(400);
    expect((await api("POST", `/api/admin/users/${alice.id}/admin`, alice.token, { value: false })).status).toBe(400);
  });

  it("registration mode is switchable at runtime", async () => {
    expect((await api("PUT", "/api/admin/settings", alice.token, { registration: "closed" })).status).toBe(200);
    expect((await api<{ registration: string }>("GET", "/api/auth/info")).body.registration).toBe("closed");
    const r = await api("POST", "/api/auth/register", null, { username: "ivan", email: "ivan@example.com", password: "correct-horse-battery" });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("registration_closed");
    expect((await api("PUT", "/api/admin/settings", alice.token, { registration: "open" })).status).toBe(200);
  });

  it("transfer a server to another member", async () => {
    const g = await api<GuildCreatePayload>("POST", "/api/guilds", bob.token, { name: "Bob's place" });
    const invite = await api<{ code: string }>("POST", `/api/guilds/${g.body.id}/invites`, bob.token, {});
    await api("POST", `/api/invites/${invite.body.code}`, alice.token);
    // The owner picker lists this server's members only.
    const members = await api<{ id: string }[]>("GET", `/api/admin/users?guild=${g.body.id}`, alice.token);
    expect(members.body.map((u) => u.id).sort()).toEqual([alice.id, bob.id].sort());
    expect((await api("POST", `/api/admin/guilds/${g.body.id}/owner`, alice.token, { userId: alice.id })).status).toBe(200);
    const list = await api<{ id: string; ownerId: string; ownerDisabled: boolean }[]>("GET", "/api/admin/guilds", alice.token);
    expect(list.body.find((x) => x.id === g.body.id)).toMatchObject({ ownerId: alice.id, ownerDisabled: false });
    // …but never to an account that can't sign in.
    await api("POST", `/api/admin/users/${bob.id}/disabled`, alice.token, { value: true });
    const refused = await api("POST", `/api/admin/guilds/${g.body.id}/owner`, alice.token, { userId: bob.id });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe("account_disabled");
    await api("POST", `/api/admin/users/${bob.id}/disabled`, alice.token, { value: false });
  });

  it("the old Concord demo account with its public password gets locked", async () => {
    const r = await api("POST", "/api/auth/register", null, { username: "demo", email: "demo@concord.dev", password: "password123" });
    expect(r.status).toBe(201);
    // The import renames case-duplicates to demo+concordN@… — those are caught too.
    expect((await api("POST", "/api/auth/register", null, { username: "demo2", email: "demo+concord2@concord.dev", password: "password123" })).status).toBe(201);
    expect((await api("POST", "/api/auth/register", null, { username: "demo3", email: "demo+concord3@concord.dev", password: "a-private-one-123" })).status).toBe(201);
    const { lockPublicDemoAccount } = await import("../src/services/admin");
    await lockPublicDemoAccount(app.log);
    const login = await api("POST", "/api/auth/login", null, { login: "demo@concord.dev", password: "password123" });
    expect(login.status).toBe(401);
    const users = await api<{ username: string; disabled: boolean; passwordLocked: boolean }[]>("GET", "/api/admin/users?q=demo", alice.token);
    expect(users.body.find((u) => u.username === "demo")).toMatchObject({ disabled: true, passwordLocked: true });
    expect(users.body.find((u) => u.username === "demo2")).toMatchObject({ disabled: true, passwordLocked: true });
    // An account with its own password is left alone.
    expect(users.body.find((u) => u.username === "demo3")).toMatchObject({ disabled: false, passwordLocked: false });
  });
});

describe("android push", () => {
  it("SSE stream carries DM pushes; the push token only works for push", async () => {
    const fred = await register("fred");
    expect((await api("POST", "/api/users/@me/relationships", fred.token, { username: "alice" })).status).toBe(200);
    expect((await api("PUT", `/api/users/@me/relationships/${fred.id}`, alice.token, {})).status).toBe(200);
    const push = (await api<{ token: string }>("POST", "/api/push/token", fred.token)).body.token;
    expect((await api("GET", "/api/auth/me", push)).status).toBe(401);

    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/push/stream?token=${encodeURIComponent(push)}`, { signal: ctrl.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dm = await api("POST", "/api/users/@me/channels", alice.token, { recipientId: fred.id });
    await api("POST", `/api/channels/${dm.body.id}/messages`, alice.token, { content: "ping from alice" });

    let buf = "";
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("no push within 5s")), 5000));
    while (!buf.includes("ping from alice")) {
      const { value, done } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      buf += new TextDecoder().decode(value);
    }
    ctrl.abort();
    const line = buf.split(/\r?\n/).find((l) => l.startsWith("data:"))!;
    expect(JSON.parse(line.slice(5))).toMatchObject({ type: "dm", authorId: alice.id, channelId: dm.body.id, body: "ping from alice" });

    expect((await api("POST", "/api/push/decline", null, { token: push, channelId: dm.body.id })).status).toBe(204);
    expect((await api("POST", "/api/push/decline", null, { token: "not-a-real-token", channelId: dm.body.id })).status).toBe(401);
  });
});

describe("profile style", () => {
  it("decoration, effect and a second colour are saved and shown to others", async () => {
    const style = { decoration: "crown", profileEffect: "waves", accentColor: 0x7a3cff, accentColor2: 0xff5c9a };
    const saved = await api("PATCH", "/api/users/@me", alice.token, style);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject(style);
    // Another user sees it in the profile — and the decoration travels with every user object (message authors too).
    const viewer = await register("gina");
    const seen = await api("GET", `/api/users/${alice.id}/profile`, viewer.token);
    expect(seen.body.user).toMatchObject(style);
    const msg = await api<MessageDTO>("POST", `/api/channels/${general}/messages`, alice.token, { content: "look at my crown" });
    expect(msg.body.author.decoration).toBe("crown");
    // Cleared with null; ids are plain preset slugs, nothing else gets stored.
    expect((await api("PATCH", "/api/users/@me", alice.token, { decoration: null, profileEffect: null, accentColor2: null })).body).toMatchObject({ decoration: null, profileEffect: null, accentColor2: null });
    expect((await api("PATCH", "/api/users/@me", alice.token, { decoration: "<svg onload=alert(1)>" })).status).toBe(400);
  });

  it("the server says where to download the apps", async () => {
    const info = await api<{ downloads: { windows: string; android: string } }>("GET", "/api/auth/info");
    expect(info.body.downloads.windows).toMatch(/^https:\/\//);
    expect(info.body.downloads.android).toMatch(/\.apk$/);
  });
});

describe("gifs", () => {
  it("search is off until an admin sets a provider key; only signed-in apps get the key", async () => {
    const user = await register("gifuser");
    expect((await api("GET", "/api/gifs/config")).status).toBe(401);
    expect((await api("GET", "/api/gifs/config", user.token)).body).toEqual({ provider: null, key: null });
    expect((await api("GET", "/api/auth/info")).body.gifs).toBe(false);

    expect((await api("PUT", "/api/admin/settings", user.token, { gifKey: "abc" })).status).toBe(403);
    expect((await api("PUT", "/api/admin/settings", alice.token, { gifKey: "not a key!" })).status).toBe(400);
    const set = await api("PUT", "/api/admin/settings", alice.token, { gifKey: " Test_key-123 " });
    expect(set.status).toBe(200);
    expect(set.body.gifKey).toBe("Test_key-123");

    const info = await api("GET", "/api/auth/info");
    expect(info.body.gifs).toBe(true);
    expect(JSON.stringify(info.body)).not.toContain("Test_key-123");
    expect((await api("GET", "/api/gifs/config", user.token)).body).toEqual({ provider: "klipy", key: "Test_key-123" });
    expect((await api("GET", "/api/admin/overview", alice.token)).body.gifKey).toBe("Test_key-123");

    // An empty key turns search off again.
    expect((await api("PUT", "/api/admin/settings", alice.token, { gifKey: "" })).status).toBe(200);
    expect((await api("GET", "/api/auth/info")).body.gifs).toBe(false);
  });

  it("favourites: star, newest first, live on other devices, unstar", async () => {
    const user = await register("gifstar");
    const other = await live(user);
    const a = { url: "https://static.klipy.com/ii/aa/bb/one.webp", preview: "https://static.klipy.com/ii/aa/bb/one-sm.webp", width: 498, height: 280 };
    const b = { url: "https://example.com/two.gif" };
    expect((await api("PUT", "/api/users/@me/gifs", user.token, a)).body).toEqual({ id: a.url, ...a });
    expect((await api("PUT", "/api/users/@me/gifs", user.token, b)).body).toEqual({ id: b.url, url: b.url, preview: b.url, width: null, height: null });
    expect((await other.waitFor("USER_GIFS_UPDATE", (d) => d.added?.url === b.url)).added?.preview).toBe(b.url);

    const list = await api<{ url: string }[]>("GET", "/api/users/@me/gifs", user.token);
    expect(list.body.map((g) => g.url)).toEqual([b.url, a.url]);
    // Starring twice keeps one copy and moves it to the top.
    await sleep(5);
    await api("PUT", "/api/users/@me/gifs", user.token, a);
    expect((await api<{ url: string }[]>("GET", "/api/users/@me/gifs", user.token)).body.map((g) => g.url)).toEqual([a.url, b.url]);
    // Somebody else's list is their own.
    expect((await api("GET", "/api/users/@me/gifs", alice.token)).body).toEqual([]);

    for (const url of ["javascript:alert(1)", "data:image/gif;base64,AAAA", "//evil.example/x.gif", ""]) {
      expect((await api("PUT", "/api/users/@me/gifs", user.token, { url })).status, url).toBe(400);
    }

    expect((await api("DELETE", `/api/users/@me/gifs?url=${encodeURIComponent(a.url)}`, user.token)).status).toBe(204);
    await other.waitFor("USER_GIFS_UPDATE", (d) => d.removed === a.url);
    expect((await api<{ url: string }[]>("GET", "/api/users/@me/gifs", user.token)).body.map((g) => g.url)).toEqual([b.url]);
  });

  it("an uploaded GIF re-sent from favourites is shown from this server and leaves favourites with its file", async () => {
    const aLive = await live(alice);
    const gif = await sharp({ create: { width: 120, height: 90, channels: 3, background: { r: 20, g: 160, b: 220 } } }).gif().toBuffer();
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(gif)], { type: "image/gif" }), "кот.gif");
    const att = await (await fetch(base + "/api/attachments", { method: "POST", headers: { authorization: `Bearer ${alice.token}` }, body: form })).json();
    expect(att.contentType).toBe("image/gif");
    const first = await api<MessageDTO>("POST", `/api/channels/${general}/messages`, alice.token, { content: "", attachments: [att.id] });
    expect((await api("PUT", "/api/users/@me/gifs", alice.token, { url: att.url, width: att.width, height: att.height })).status).toBe(200);

    // The favourite goes out as a plain link; the preview is the file itself — not fetched, not proxied.
    const again = await api<MessageDTO>("POST", `/api/channels/${general}/messages`, alice.token, { content: base + att.url });
    const updated = await aLive.waitFor("MESSAGE_UPDATE", (d) => d.id === again.body.id && d.embeds.length > 0);
    expect(updated.embeds[0]).toMatchObject({ type: "image", url: base + att.url, image: { url: att.url, width: 120, height: 90 } });

    expect((await api("DELETE", `/api/channels/${general}/messages/${first.body.id}`, alice.token)).status).toBeLessThan(300);
    await aLive.waitFor("USER_GIFS_UPDATE", (d) => d.removed === att.url);
    expect((await api("GET", "/api/users/@me/gifs", alice.token)).body).toEqual([]);
  });
});

describe("soundboard sounds and voice presets", () => {
  /** A short tone as a WAV file. */
  const wav = () => {
    const n = 8000;
    const b = Buffer.alloc(44 + n * 2);
    b.write("RIFF", 0);
    b.writeUInt32LE(36 + n * 2, 4);
    b.write("WAVEfmt ", 8);
    b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20);
    b.writeUInt16LE(1, 22);
    b.writeUInt32LE(16000, 24);
    b.writeUInt32LE(32000, 28);
    b.writeUInt16LE(2, 32);
    b.writeUInt16LE(16, 34);
    b.write("data", 36);
    b.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 5) * 9000), 44 + i * 2);
    return b;
  };
  const upload = async (acc: Acc, file: Buffer, type: string, query: Record<string, string>) => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(file)], { type }), "sound.wav");
    const res = await fetch(`${base}/api/sounds?${new URLSearchParams(query)}`, { method: "POST", headers: { authorization: `Bearer ${acc.token}` }, body: form });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const params = { pitch: -5, robot: 0.3, robotHz: 60, drive: 0.2, lowpass: 6000, highpass: 120, echo: 0, echoMs: 250, reverb: 0.2, room: 1.5, tremolo: 0, tremoloHz: 5, trim: 0.8 };

  it("own sounds follow the owner; server sounds every member; only the author or an emoji manager changes them", async () => {
    const owner = await register("sbowner");
    const member = await register("sbmember");
    const stranger = await register("sbstranger");
    const g = (await api("POST", "/api/guilds", owner.token, { name: "Звуки", template: "default", locale: "ru" })).body;
    const inv = await api("POST", `/api/guilds/${g.id}/invites`, owner.token, { maxAge: 3600, maxUses: 0 });
    expect((await api("POST", `/api/invites/${inv.body.code}`, member.token)).status).toBe(200);
    const ownerLive = await live(owner);

    // Personal: only the owner sees it, on any device.
    const mine = await upload(member, wav(), "audio/wav", { name: "Бадумтс", emoji: "🥁" });
    expect(mine.status, JSON.stringify(mine.body)).toBe(201);
    expect(mine.body).toMatchObject({ name: "Бадумтс", emoji: "🥁", guildId: null, ownerId: member.id });
    const served = await fetch(base + mine.body.url);
    expect(served.headers.get("content-type")).toBe("audio/wav");
    expect((await api("GET", "/api/expressions", member.token)).body.sounds.map((s: { id: string }) => s.id)).toContain(mine.body.id);
    expect((await api("GET", "/api/expressions", owner.token)).body.sounds.map((s: { id: string }) => s.id)).not.toContain(mine.body.id);

    // Shared with the server: every member gets it, live.
    const shared = await upload(member, wav(), "audio/wav", { name: "Горн", emoji: "📯", guildId: g.id });
    expect(shared.status).toBe(201);
    await ownerLive.waitFor("SOUND_UPSERT", (s) => s.id === shared.body.id);
    expect((await api("GET", "/api/expressions", owner.token)).body.sounds.map((s: { id: string }) => s.id)).toContain(shared.body.id);
    // …but not to people outside it.
    expect((await upload(stranger, wav(), "audio/wav", { name: "Нет", guildId: g.id })).status).toBe(404);
    expect((await api("GET", "/api/expressions", stranger.token)).body.sounds).toEqual([]);

    // Not audio → refused; nobody else edits a personal sound.
    expect((await upload(member, Buffer.from("<html>nope</html>"), "audio/wav", { name: "html" })).body.error.code).toBe("invalid_audio");
    expect((await api("PATCH", `/api/sounds/${mine.body.id}`, owner.token, { name: "чужое" })).status).toBe(403);
    expect((await api("PATCH", `/api/sounds/${mine.body.id}`, member.token, { name: "Ба-дум" })).body.name).toBe("Ба-дум");

    // The server owner (emoji manager) can remove a shared one; members are told.
    expect((await api("DELETE", `/api/sounds/${shared.body.id}`, owner.token)).status).toBe(204);
    await ownerLive.waitFor("SOUND_DELETE", (d) => d.id === shared.body.id && d.guildId === g.id);
    expect((await fetch(base + shared.body.url)).status).toBe(404);
    expect((await api("DELETE", `/api/sounds/${mine.body.id}`, owner.token)).status).toBe(403);
    expect((await api("DELETE", `/api/sounds/${mine.body.id}`, member.token)).status).toBe(204);

    // Copy between yours and the server's (the soundboard's drag and drop): an independent copy.
    const again = await upload(member, wav(), "audio/wav", { name: "Ещё один", emoji: "🎺" });
    const toServer = await api("POST", `/api/sounds/${again.body.id}/copy`, member.token, { guildId: g.id });
    expect(toServer.status, JSON.stringify(toServer.body)).toBe(201);
    expect(toServer.body).toMatchObject({ name: "Ещё один", emoji: "🎺", guildId: g.id, ownerId: member.id });
    expect(toServer.body.url).not.toBe(again.body.url);
    await ownerLive.waitFor("SOUND_UPSERT", (s) => s.id === toServer.body.id);
    // The server owner takes the server's copy into their own sounds…
    const mineNow = await api("POST", `/api/sounds/${toServer.body.id}/copy`, owner.token, { guildId: null });
    expect(mineNow.body).toMatchObject({ guildId: null, ownerId: owner.id, name: "Ещё один" });
    // …and it survives the original going away.
    expect((await api("DELETE", `/api/sounds/${toServer.body.id}`, owner.token)).status).toBe(204);
    expect((await fetch(base + mineNow.body.url)).status).toBe(200);
    // A stranger can neither see nor copy someone's own sound, nor copy onto a server they're not in.
    expect((await api("POST", `/api/sounds/${again.body.id}/copy`, stranger.token, { guildId: null })).status).toBe(404);
    expect((await api("POST", `/api/sounds/${mineNow.body.id}/copy`, owner.token, { guildId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" })).status).toBe(404);

    // Order: yours, as dragged; new ones go to the end.
    const third = await upload(member, wav(), "audio/wav", { name: "Третий" });
    const list = async () => (await api("GET", "/api/expressions", member.token)).body.sounds.filter((s: { guildId: string | null }) => !s.guildId).map((s: { name: string }) => s.name);
    expect(await list()).toEqual(["Ещё один", "Третий"]);
    const order = await api("PUT", "/api/sounds/order", member.token, { guildId: null, ids: [third.body.id, again.body.id] });
    expect(order.status).toBe(200);
    expect(await list()).toEqual(["Третий", "Ещё один"]);
    // A server's order is for its emoji managers.
    expect((await api("PUT", "/api/sounds/order", member.token, { guildId: g.id, ids: [] })).status).toBe(403);
    expect((await api("PUT", "/api/sounds/order", owner.token, { guildId: g.id, ids: [] })).status).toBe(200);

    // Voice presets: same rules, parameters are range-checked.
    const preset = await api("POST", "/api/voice-presets", member.token, { name: "Мой бас", emoji: "🗿", params, guildId: g.id });
    expect(preset.status, JSON.stringify(preset.body)).toBe(201);
    await ownerLive.waitFor("VOICE_PRESET_UPSERT", (p) => p.id === preset.body.id);
    expect((await api("GET", "/api/expressions", owner.token)).body.presets[0]).toMatchObject({ name: "Мой бас", params });
    expect((await api("POST", "/api/voice-presets", member.token, { name: "x", params: { ...params, pitch: 40 } })).status).toBe(400);
    expect((await api("PATCH", `/api/voice-presets/${preset.body.id}`, member.token, { params: { ...params, pitch: 3 } })).body.params.pitch).toBe(3);
    expect((await api("DELETE", `/api/voice-presets/${preset.body.id}`, stranger.token)).status).toBe(403);
    expect((await api("DELETE", `/api/voice-presets/${preset.body.id}`, member.token)).status).toBe(204);
  });
});

describe("password-reset mail", () => {
  /** A minimal SMTP server that accepts everything and keeps the letters. */
  async function fakeSmtp() {
    const { createServer } = await import("node:net");
    const letters: { to: string; data: string }[] = [];
    let auth = "";
    const server = createServer((sock) => {
      let to = "";
      let data = "";
      let inData = false;
      let buf = "";
      sock.write("220 fake ESMTP\r\n");
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let i: number;
        while ((i = buf.indexOf("\r\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (inData) {
            if (line === ".") {
              inData = false;
              letters.push({ to, data });
              sock.write("250 queued\r\n");
            } else data += line + "\n";
            continue;
          }
          const cmd = line.toUpperCase();
          if (cmd.startsWith("EHLO")) sock.write("250-fake\r\n250 AUTH PLAIN LOGIN\r\n");
          else if (cmd.startsWith("AUTH PLAIN")) {
            auth = Buffer.from(line.split(" ")[2] ?? "", "base64").toString("utf8");
            sock.write("235 ok\r\n");
          } else if (cmd.startsWith("MAIL FROM")) sock.write("250 ok\r\n");
          else if (cmd.startsWith("RCPT TO")) {
            to = /<(.+)>/.exec(line)?.[1] ?? "";
            sock.write("250 ok\r\n");
          } else if (cmd === "DATA") {
            inData = true;
            data = "";
            sock.write("354 go\r\n");
          } else if (cmd === "QUIT") sock.end("221 bye\r\n");
          else sock.write("250 ok\r\n");
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { port: (server.address() as AddressInfo).port, letters, auth: () => auth, close: () => server.close() };
  }

  it("an admin sets the mail account in the app; a reset code arrives and works", async () => {
    const smtp = await fakeSmtp();
    try {
      const nobody = await register("mailnobody");
      expect((await api("PUT", "/api/admin/mail", nobody.token, { host: "127.0.0.1", port: smtp.port, user: "x" })).status).toBe(403);
      const saved = await api("PUT", "/api/admin/mail", alice.token, { host: "127.0.0.1", port: smtp.port, user: "nova@example.com", pass: "app-secret" });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(saved.body.mail).toEqual({ host: "127.0.0.1", port: smtp.port, user: "nova@example.com", from: "", hasPassword: true });
      // The password is never sent back.
      expect(JSON.stringify((await api("GET", "/api/admin/overview", alice.token)).body)).not.toContain("app-secret");
      expect((await api("GET", "/api/auth/info")).body.mail).toBe(true);

      const test = await api("POST", "/api/admin/mail/test", alice.token);
      expect(test.status, JSON.stringify(test.body)).toBe(200);
      expect(smtp.letters.at(-1)?.to).toBe(test.body.to);
      expect(smtp.auth()).toContain("app-secret");

      // Saving again without a password keeps it.
      await api("PUT", "/api/admin/mail", alice.token, { host: "127.0.0.1", port: smtp.port, user: "nova@example.com", from: "Nova <nova@example.com>" });
      expect((await api("GET", "/api/admin/overview", alice.token)).body.mail.hasPassword).toBe(true);

      const kim = await register("kimreset");
      expect((await api("POST", "/api/auth/forgot", null, { email: "kimreset@example.com" })).status).toBe(200);
      await expect.poll(() => smtp.letters.find((l) => l.to === "kimreset@example.com")).toBeTruthy();
      const letter = smtp.letters.find((l) => l.to === "kimreset@example.com")!;
      const body = letter.data.includes("base64") ? Buffer.from(letter.data.split("\n\n").slice(1).join("").replace(/\s/g, ""), "base64").toString("utf8") : letter.data;
      const code = /([0-9A-F]{8})/.exec(body)?.[1];
      expect(code, body).toBeTruthy();
      expect((await api("POST", "/api/auth/reset", null, { email: "kimreset@example.com", code, password: "brand-new-pass-1" })).status).toBe(200);
      expect((await api("POST", "/api/auth/login", null, { login: "kimreset", password: "brand-new-pass-1" })).status).toBe(200);
      expect((await api("GET", "/api/auth/me", kim.token)).status).toBe(401); // old sessions are out

      // A wrong account is reported, not hidden.
      await api("PUT", "/api/admin/mail", alice.token, { host: "127.0.0.1", port: 1, user: "nova@example.com", pass: "x" });
      const failed = await api("POST", "/api/admin/mail/test", alice.token);
      expect(failed.status).toBe(400);
      expect(failed.body.error.code).toBe("mail_failed");
      // Turned off again.
      expect((await api("DELETE", "/api/admin/mail", alice.token)).body.mail).toBeNull();
      expect((await api("GET", "/api/auth/info")).body.mail).toBe(false);
    } finally {
      smtp.close();
    }
  });
});

describe("apps and links", () => {
  // The desktop app (app://nova) and the Android WebView call the API cross-origin:
  // every method the client uses must pass the CORS preflight.
  it("the CORS preflight allows every method the apps use", async () => {
    for (const method of ["PATCH", "PUT", "DELETE"]) {
      const res = await fetch(base + "/api/users/@me", {
        method: "OPTIONS",
        headers: { origin: "app://nova", "access-control-request-method": method, "access-control-request-headers": "authorization,content-type,x-nova-platform" },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("app://nova");
      expect(res.headers.get("access-control-allow-methods") ?? "", method).toContain(method);
    }
  });

  // The web build uses relative asset paths, so a page opened at /invite/CODE
  // would look for /invite/assets/… — deep links go to the hash route instead.
  it("invite links open the web app on its hash route", async () => {
    const res = await fetch(base + "/invite/AbC-12", { headers: { accept: "text/html" }, redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/#/invite/AbC-12");
    const other = await fetch(base + "/some/deep/path", { headers: { accept: "text/html" }, redirect: "manual" });
    expect(other.headers.get("location")).toBe("/#/some/deep/path");
    expect((await fetch(base + "/api/nope", { headers: { accept: "text/html" }, redirect: "manual" })).status).toBe(404);
  });
});

describe("ssrf guard", () => {
  it("blocks internal addresses", async () => {
    const { isPrivateIp, safeFetch } = await import("../src/lib/ssrf");
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.20.0.1", "169.254.169.254", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "100.64.0.1"]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPrivateIp(ip), ip).toBe(false);
    await expect(safeFetch(base + "/health")).rejects.toThrow();
    await expect(safeFetch("http://localhost:1/")).rejects.toThrow();
  });
});

describe("radio", () => {
  it("people in the call share a queue; others can't touch it; leaving cleans up", async () => {
    const dj = await register("dj");
    const fan = await register("fan");
    const g = await api<GuildCreatePayload>("POST", "/api/guilds", dj.token, { name: "Радио", template: "default", locale: "ru" });
    const inv = await api<{ code: string }>("POST", `/api/guilds/${g.body.id}/invites`, dj.token, { maxAge: 0, maxUses: 0 });
    await api("POST", `/api/invites/${inv.body.code}`, fan.token);
    const ch = g.body.channels.find((c) => c.type === "voice")!.id;
    const { voice } = await import("../src/state/voice");

    // Not in the call: refused.
    expect((await api("POST", `/api/channels/${ch}/radio/items`, dj.token, { kind: "file", title: "Песня", duration: 120 })).status).toBe(403);

    await voice.onJoin(dj.id, ch, "sid-dj");
    await voice.onJoin(fan.id, ch, "sid-fan");
    const fanLive = await live(fan);
    const added = await api<{ id: string }>("POST", `/api/channels/${ch}/radio/items`, dj.token, { kind: "file", title: "Песня", duration: 120 });
    expect(added.status).toBe(200);
    const st = await fanLive.waitFor("RADIO_STATE", (s) => s.channelId === ch && s.items.length === 1);
    expect(st.current?.itemId).toBe(added.body.id);

    // A Yandex link is a card, not a track; a page link with kind "link" must be http(s).
    expect((await api("POST", `/api/channels/${ch}/radio/links`, fan.token, { url: "https://music.yandex.ru/album/1/track/2" })).status).toBe(200);
    expect((await api("POST", `/api/channels/${ch}/radio/links`, fan.token, { url: "https://example.com/a.mp3" })).status).toBe(400);
    expect((await api("POST", `/api/channels/${ch}/radio/items`, fan.token, { kind: "link", title: "x", duration: 10, url: "ftp://x/y.mp3" })).status).toBe(400);

    // The fan can't remove the DJ's track; the DJ can.
    const second = await api<{ id: string }>("POST", `/api/channels/${ch}/radio/items`, dj.token, { kind: "file", title: "Вторая", duration: 60 });
    expect((await api("DELETE", `/api/channels/${ch}/radio/items/${second.body.id}`, fan.token)).status).toBe(403);

    // The DJ leaves: their second track goes, the current one stays.
    await voice.onLeave(dj.id, ch);
    const after = await api<{ items: { id: string }[] }>("GET", `/api/channels/${ch}/radio`, fan.token);
    expect(after.body.items.map((i) => i.id)).toEqual([added.body.id]);
    await voice.onLeave(fan.id, ch);
    expect((await api<{ items: unknown[] }>("GET", `/api/channels/${ch}/radio`, dj.token)).body.items).toEqual([]);
  });

  it("FM: a station plays for the call (an http one through the relay); off again; the relay only opens signed addresses", async () => {
    const host = await register("fmhost");
    const guest = await register("fmguest");
    const g = await api<GuildCreatePayload>("POST", "/api/guilds", host.token, { name: "Эфир", template: "default", locale: "ru" });
    const inv = await api<{ code: string }>("POST", `/api/guilds/${g.body.id}/invites`, host.token, { maxAge: 0, maxUses: 0 });
    await api("POST", `/api/invites/${inv.body.code}`, guest.token);
    const ch = g.body.channels.find((c) => c.type === "voice")!.id;
    const { voice } = await import("../src/state/voice");
    await voice.onJoin(host.id, ch, "sid-fmhost");
    await voice.onJoin(guest.id, ch, "sid-fmguest");

    // A tiny "station" on this machine: an endless trickle of mp3-ish bytes.
    const { createServer } = await import("node:http");
    const station = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "audio/mpeg" });
      const t = setInterval(() => res.write(Buffer.alloc(512, 7)), 20);
      res.on("close", () => clearInterval(t));
    });
    await new Promise<void>((r) => station.listen(0, "127.0.0.1", r));
    const stationUrl = `http://127.0.0.1:${(station.address() as AddressInfo).port}/live.mp3`;

    const on = await api<{ station: { name: string; play: string; startedBy: string } | null }>("POST", `/api/channels/${ch}/radio/station`, guest.token, { name: "Тест FM", url: stationUrl });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body.station).toMatchObject({ name: "Тест FM", startedBy: guest.id });
    expect(on.body.station!.play.startsWith("/api/radio/relay?u=")).toBe(true);

    // The relay passes the stream on (no auth: an audio element can't send one — the signature is the key).
    const ctl = new AbortController();
    const relayed = await fetch(base + on.body.station!.play, { signal: ctl.signal });
    expect(relayed.status).toBe(200);
    expect(relayed.headers.get("content-type")?.startsWith("audio/")).toBe(true);
    const reader = relayed.body!.getReader();
    let got = 0;
    while (got < 2048) got += (await reader.read()).value?.length ?? 0;
    ctl.abort();
    station.close();
    // Not signed by this server: no relay.
    const forged = `/api/radio/relay?u=${Buffer.from("http://example.com/x.mp3").toString("base64url")}&s=AAAAAAAAAAAAAAAAAAAAAA`;
    expect((await fetch(base + forged)).status).toBe(403);

    const off = await api<{ station: unknown }>("DELETE", `/api/channels/${ch}/radio/station`, host.token);
    expect(off.body.station).toBeNull();
    await voice.onLeave(guest.id, ch);
    await voice.onLeave(host.id, ch);
  });

  it("FM stations come from this server: popular ones, and a search (no VPN needed)", async () => {
    const top = await api<{ stations: { name: string; url: string }[] }>("GET", "/api/radio/stations", alice.token);
    expect(top.status).toBe(200);
    expect(top.body.stations.length).toBeGreaterThan(20);
    const found = await api<{ stations: { name: string }[] }>("GET", `/api/radio/stations?q=${encodeURIComponent("европа")}`, alice.token);
    expect(found.body.stations.map((s) => s.name)).toContain("Europa Plus");
    expect((await api("GET", "/api/radio/stations")).status).toBe(401);
  });

  it("a server mute covers the radio: no adding, skipping or pausing", async () => {
    const mod = await register("radiomod");
    const loud = await register("radioloud");
    const g = await api<GuildCreatePayload>("POST", "/api/guilds", mod.token, { name: "Тишина", template: "default", locale: "ru" });
    const inv = await api<{ code: string }>("POST", `/api/guilds/${g.body.id}/invites`, mod.token, { maxAge: 0, maxUses: 0 });
    await api("POST", `/api/invites/${inv.body.code}`, loud.token);
    const ch = g.body.channels.find((c) => c.type === "voice")!.id;
    const { voice } = await import("../src/state/voice");
    await voice.onJoin(mod.id, ch, "sid-mod");
    await voice.onJoin(loud.id, ch, "sid-loud");
    const song = await api<{ id: string }>("POST", `/api/channels/${ch}/radio/items`, mod.token, { kind: "file", title: "Песня", duration: 100 });
    expect((await api("PATCH", `/api/guilds/${g.body.id}/voice/${loud.id}`, mod.token, { mute: true })).status).toBe(200);
    expect((await api("POST", `/api/channels/${ch}/radio/items`, loud.token, { kind: "file", title: "Громко", duration: 10 })).status).toBe(403);
    expect((await api("POST", `/api/channels/${ch}/radio/skip`, loud.token, { itemId: song.body.id })).status).toBe(403);
    expect((await api("POST", `/api/channels/${ch}/radio/pause`, loud.token)).status).toBe(403);
    await voice.onLeave(loud.id, ch);
    await voice.onLeave(mod.id, ch);
  });
});
