import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";

// Every window a test opens is closed once the next test opens its first: left
// open, their calls kept running through the rest of the suite, and the last
// tests ran beside dozens of them. (A test.afterEach in this shared module would
// attach only to the first spec file that loads it.)
const opened = new Set<BrowserContext>();
let openedFor = "";
async function closeOthers() {
  const id = test.info().testId;
  if (id === openedFor) return;
  openedFor = id;
  await Promise.all([...opened].map((c) => c.close().catch(() => {})));
  opened.clear();
}

export const BASE = process.env.E2E_URL ?? "http://localhost:5173";
export const run = Date.now().toString(36).slice(-6);
let seq = 0;

export interface User {
  id: string;
  username: string;
  displayName: string;
  email: string;
  password: string;
  access: string;
  refresh: string;
}

/** A unique handle per test run (valid Nova username). */
export const handle = (tag: string) => `e2e_${tag}_${run}_${++seq}`.slice(0, 32);

export async function register(request: APIRequestContext, displayName: string): Promise<User> {
  const username = handle("u");
  const email = `${username}@e2e.test`;
  const password = "e2e-secret-pass-1";
  const res = await request.post(`${BASE}/api/auth/register`, { data: { username, email, password, displayName } });
  expect(res.status(), await res.text()).toBe(201);
  const b = await res.json();
  return { id: b.user.id, username, displayName, email, password, access: b.accessToken, refresh: b.refreshToken };
}

/** Instance-admin rights the way a deploy grants them (deploy/setup.sh → scripts/grant-admin.ts). Local stack only. */
export function grantAdmin(user: User) {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/grant-admin.ts", user.username], { cwd: fileURLToPath(new URL("../server/", import.meta.url)), stdio: "pipe" });
}

export async function api<T = any>(request: APIRequestContext, user: User, method: string, path: string, data?: unknown): Promise<T> {
  const res = await request.fetch(`${BASE}${path}`, { method, data, headers: { authorization: `Bearer ${user.access}` } });
  const text = await res.text();
  expect(res.ok(), `${method} ${path} → ${res.status()} ${text}`).toBeTruthy();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** A guild owned by `owner` (from a template) that `members` joined by invite. */
export async function guildWith(request: APIRequestContext, owner: User, members: User[], template = "default") {
  const g = await api<{ id: string; name: string; channels: { id: string; type: string; name: string }[] }>(request, owner, "POST", "/api/guilds", {
    name: `E2E ${owner.displayName}`,
    template,
    locale: "ru",
  });
  const invite = await api<{ code: string }>(request, owner, "POST", `/api/guilds/${g.id}/invites`, { maxAge: 0, maxUses: 0 });
  for (const m of members) await api(request, m, "POST", `/api/invites/${invite.code}`);
  const text = g.channels.find((c) => c.type === "text")!;
  const voice = g.channels.find((c) => c.type === "voice")!;
  return { guild: g, text, voice, invite: invite.code };
}

export async function befriend(request: APIRequestContext, a: User, b: User) {
  await api(request, a, "POST", "/api/users/@me/relationships", { username: b.username });
  await api(request, b, "PUT", `/api/users/@me/relationships/${a.id}`, {});
}

// Console noise that isn't an app bug (network probes, media stack chatter).
const IGNORED = [/registered handler/i, /favicon/i, /Failed to load resource: the server responded with a status of 40[134]/i, /\[livekit\]/i, /ResizeObserver loop/i, /net::ERR_ABORTED/i];

export interface Session {
  context: BrowserContext;
  page: Page;
  /** Uncaught exceptions and console errors seen on this page. */
  errors: string[];
}

export async function openAs(
  browser: Browser,
  user: User | null,
  path = "/",
  opts: {
    viewport?: { width: number; height: number };
    desktop?: boolean;
    /** Call the API on this address (cross-origin, like the desktop and Android apps). */
    server?: string;
    /** Device-local settings to start with (e.g. { noise: "off" }). */
    local?: Record<string, unknown>;
    /** Raw localStorage entries (test knobs such as "nova.test.aloneMs"). */
    storage?: Record<string, string>;
  } = {}
): Promise<Session> {
  await closeOthers();
  const context = await browser.newContext({
    baseURL: BASE,
    locale: "ru-RU",
    viewport: opts.viewport ?? { width: 1366, height: 768 },
    permissions: ["microphone", "camera", "notifications"],
  });
  if (user) {
    // Seed the session once per tab, so logging out inside a test sticks.
    await context.addInitScript(
      ([a, r]) => {
        if (sessionStorage.getItem("e2e.seeded")) return;
        localStorage.setItem("nova.access", a);
        localStorage.setItem("nova.refresh", r);
        sessionStorage.setItem("e2e.seeded", "1");
      },
      [user.access, user.refresh]
    );
  }
  if (opts.local) await context.addInitScript((l) => localStorage.setItem("nova.settings.local", JSON.stringify({ localVersion: 1, ...l })), opts.local);
  if (opts.storage) await context.addInitScript((entries) => Object.entries(entries).forEach(([k, v]) => localStorage.setItem(k, v)), opts.storage);
  if (opts.desktop) await context.addInitScript(stubDesktopBridge);
  if (opts.server) await context.addInitScript((url) => localStorage.setItem("nova.server", url), opts.server);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !IGNORED.some((re) => re.test(m.text()))) errors.push(`console: ${m.text()}`);
  });
  await page.goto(path);
  if (user) await expect(page.locator("[data-shell]")).toBeVisible({ timeout: 20_000 });
  opened.add(context);
  return { context, page, errors };
}

/** Pretend to be the Electron app (window.nova) — exercises the desktop-only UI in a browser. */
function stubDesktopBridge() {
  const noop = () => {};
  const off = () => noop;
  (window as unknown as { nova: unknown }).nova = {
    platform: "win32",
    version: "e2e",
    getSources: async () => [],
    selectSource: noop,
    onScreenPick: off,
    setCloseToTray: noop,
    setBadge: noop,
    flashFrame: noop,
    notify: noop,
    onNotificationClick: off,
    window: { minimize: noop, maximize: noop, close: noop, isMaximized: () => false, onMaximizeChange: off },
    onUpdate: off,
    installUpdate: noop,
    onActivity: off,
    setGlobalShortcuts: noop,
    onGlobalShortcut: off,
    setOverlay: noop,
    onOverlayData: off,
    // Links opened in the system browser: tests read them from window.__external.
    openExternal: (url: string) => ((window as unknown as { __external: string[] }).__external ??= []).push(url),
    setAutoLaunch: noop,
    // Screen-share audio from the Windows helper: tests drive it through window.__appAudio.
    onAppAudio: (cb: unknown) => {
      (window as unknown as { __appAudio: unknown }).__appAudio = cb;
      return noop;
    },
    stopAppAudio: () => {
      const w = window as unknown as { __appAudioStops?: number };
      w.__appAudioStops = (w.__appAudioStops ?? 0) + 1;
    },
  };
}

export const composer = (page: Page) => page.locator('[contenteditable="true"], textarea').last();

export async function send(page: Page, text: string) {
  const box = composer(page);
  await box.click();
  await box.fill(text);
  await box.press("Enter");
}

/** The first message row containing `text` (replies quoting it come later). */
export const messageRow = (page: Page, text: string) => page.locator("[data-mid]").filter({ hasText: text }).first();

export function noErrors(...sessions: Session[]) {
  const all = sessions.flatMap((s) => s.errors);
  expect(all, all.join("\n")).toEqual([]);
}
