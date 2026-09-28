// Where the server lives. Web build served by the server → same origin.
// Desktop/Android builds get VITE_API_URL baked in (authoritative); without it
// the user can type a server address on the login screen.
// Resilience: an optional VITE_API_URL_FALLBACK (e.g. plain-IP http) is used
// when the primary can't be reached from a given network.

const KEY = "nova.server";
const ACTIVE_KEY = "nova.server.active";
const BAKED = (import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "");
const FALLBACK = (import.meta.env.VITE_API_URL_FALLBACK ?? "").replace(/\/+$/, "");

/** True when the build pins a server (no address field on the login screen). */
export const serverPinned = !!BAKED;

/** Packaged app (Electron app:// / file://, native Capacitor WebView) — there is no "same origin" server.
 *  Note: @capacitor/core defines window.Capacitor in plain browsers too, so ask it for the platform. */
const packaged = () => {
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return location.protocol === "file:" || location.protocol === "app:" || !!cap?.isNativePlatform?.();
};

/** The desktop page (app://) is a secure context: plain-http addresses are blocked there as mixed content. */
const usable = (base: string) => !(location.protocol === "app:" && base.startsWith("http:"));

export function serverBase(): string {
  if (BAKED) {
    const active = safeGet(ACTIVE_KEY);
    return active && (active === BAKED || active === FALLBACK) && usable(active) ? active : BAKED;
  }
  return safeGet(KEY) ?? "";
}

/** Offer "change server": apps always; same-origin web only if an address was set by hand. */
export const canChangeServer = () => !serverPinned && (packaged() || !!safeGet(KEY));

/** A usable server is known (same-origin web counts). */
export function hasServer(): boolean {
  return !!BAKED || !!safeGet(KEY) || !packaged();
}

export function setServerBase(url: string) {
  const clean = normalizeServer(url);
  if (clean) localStorage.setItem(KEY, clean);
  else localStorage.removeItem(KEY);
}

export function normalizeServer(input: string): string {
  let v = input.trim().replace(/\/+$/, "");
  if (!v) return "";
  if (!/^https?:\/\//i.test(v)) v = (/^(localhost|\d+\.\d+\.\d+\.\d+)(:\d+)?$/.test(v) ? "http://" : "https://") + v;
  return v;
}

const reachable = (base: string) =>
  fetch(`${base}/health`, { cache: "no-store", signal: AbortSignal.timeout(5000) }).then(
    (r) => r.ok,
    () => false
  );

/**
 * Switch primary ↔ fallback after a network-level failure; returns true if
 * switched. A blocked request looks exactly like a network error to fetch(), so
 * the switch happens only when the current address really doesn't answer and
 * the other one does — never because of one failed call.
 */
let switching: Promise<boolean> | null = null;
export function switchToFallback(): Promise<boolean> {
  // Requests failing together share one check.
  return (switching ??= (async () => {
    if (!BAKED || !FALLBACK || FALLBACK === BAKED) return false;
    const cur = serverBase();
    const next = cur === BAKED ? FALLBACK : BAKED;
    if (!usable(next) || (await reachable(cur)) || !(await reachable(next))) return false;
    localStorage.setItem(ACTIVE_KEY, next);
    return true;
  })().finally(() => (switching = null)));
}

/** Hosts this app talks to (the server, its fallback, or the page itself on the web). */
function ownHosts(): string[] {
  return [serverBase() || location.origin, BAKED, FALLBACK].filter(Boolean).map((b) => new URL(b).host);
}

/** The code when `url` is an invite link to this server (…/invite/CODE or …/#/invite/CODE), else null. */
export function inviteCodeFromUrl(url: string, hosts: string[] = ownHosts()): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!hosts.includes(u.host)) return null;
  return (/^\/invite\/([\w-]+)\/?$/.exec(u.pathname) ?? /^#\/invite\/([\w-]+)/.exec(u.hash))?.[1] ?? null;
}

export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return serverBase() + (path.startsWith("/") ? path : `/${path}`);
}

/**
 * Shareable web link (invites, channel/message links). Apps must not use their
 * own origin — that's app://nova or https://localhost on Android.
 */
export function webLink(path: string): string {
  const base = (serverBase() || location.origin).replace(/\/+$/, "");
  return base + (path.startsWith("/") ? path : `/${path}`);
}

/** Absolute URL for server-hosted media, optionally a resized image variant. */
export function mediaUrl(path: string | null | undefined, width?: number): string | undefined {
  if (!path) return undefined;
  if (/^(https?:|data:|blob:)/i.test(path)) return path;
  const url = apiUrl(path);
  if (width && path.startsWith("/files/")) return `${url}?w=${Math.round(width * Math.min(2, window.devicePixelRatio || 1))}`;
  return url;
}

/** LiveKit signaling URL: explicit from the server, else same host over ws(s). */
export function voiceUrl(fromServer: string | null | undefined): string {
  if (fromServer) return fromServer;
  const base = serverBase() || location.origin;
  return base.replace(/^http/i, "ws");
}

function safeGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
