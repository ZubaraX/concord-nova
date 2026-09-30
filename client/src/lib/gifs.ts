// GIFs.
//  · Search talks to KLIPY straight from the app (its terms want requests and
//    media loads to come from the user's device); our server only hands out
//    the app key an admin saved.
//  · Favourites live on our server — the same list on every device — and work
//    without any search.
//  · Recently sent ones are remembered on this device.
import { create } from "zustand";
import type { GifConfigDTO, GifDTO } from "@nova/shared";
import { ApiError, api } from "./api";
import { serverBase, webLink } from "./server";
import { errorText, getLocale } from "./i18n";
import { toast } from "./bus";

// ── provider ─────────────────────────────────────────────────────────────────
const KLIPY = "https://api.klipy.com/api/v1";
/** KLIPY's media CDN: shown as it is, never through our proxy. */
const PROVIDER_MEDIA_RE = /(^|\.)klipy\.com$/i;

export type GifFailure = "key" | "rate" | "network";
export class GifError extends Error {
  constructor(public reason: GifFailure) {
    super(`gif_${reason}`);
  }
}

let config: { at: number; value: GifConfigDTO } | null = null;

/** The search provider this server is set up with (asked again after a minute — an admin may have just changed it). */
export async function gifConfig(force = false): Promise<GifConfigDTO> {
  if (!force && config && Date.now() - config.at < 60_000) return config.value;
  let value: GifConfigDTO;
  try {
    value = await api<GifConfigDTO>("/api/gifs/config");
  } catch (e) {
    // A server from before 1.2 has no such route: search is simply off.
    if (e instanceof ApiError && e.status === 404) value = { provider: null, key: null };
    else throw e;
  }
  config = { at: Date.now(), value };
  return value;
}
export const forgetGifConfig = () => {
  config = null;
};

/** A stable anonymous id: KLIPY uses it to keep one person's results consistent. */
function customerId(): string {
  try {
    let id = localStorage.getItem("nova.gifCustomer");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("nova.gifCustomer", id);
    }
    return id;
  } catch {
    return "nova";
  }
}

interface KlipyMedia {
  url?: string;
  width?: number;
  height?: number;
}
type KlipyFile = Record<string, Record<string, KlipyMedia | undefined> | undefined>;
interface KlipyItem {
  id?: string | number;
  slug?: string;
  file?: KlipyFile;
}

function pick(file: KlipyFile | undefined, sizes: string[], formats: string[]): KlipyMedia | undefined {
  for (const s of sizes)
    for (const f of formats) {
      const m = file?.[s]?.[f];
      if (m?.url) return m;
    }
  return undefined;
}

function toGif(it: KlipyItem): GifDTO | null {
  // Animated WebP is several times lighter than the same GIF; plain GIF is the fallback.
  const full = pick(it.file, ["hd", "md", "sm", "xs"], ["webp", "gif"]);
  if (!full?.url) return null;
  const small = pick(it.file, ["sm", "xs", "md"], ["webp", "gif"]) ?? full;
  return { id: String(it.id ?? it.slug ?? full.url), url: full.url, preview: small.url ?? full.url, width: full.width ?? null, height: full.height ?? null, slug: it.slug };
}

async function klipy<T>(key: string, path: string, params: Record<string, string | number>, signal?: AbortSignal): Promise<T> {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  let res: Response;
  try {
    res = await fetch(`${KLIPY}/${encodeURIComponent(key)}/${path}?${qs}`, { signal, headers: { accept: "application/json" } });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new GifError("network");
  }
  if (res.status === 429) throw new GifError("rate");
  // An unknown key is answered with 404 "The provided API key is invalid".
  if (res.status === 401 || res.status === 403 || res.status === 404) throw new GifError("key");
  if (!res.ok) throw new GifError("network");
  try {
    return (await res.json()) as T;
  } catch {
    throw new GifError("network");
  }
}

export interface GifPage {
  items: GifDTO[];
  more: boolean;
}

// A test key allows 100 requests an hour for the whole server — don't ask twice for the same page.
const pages = new Map<string, { at: number; page: GifPage }>();
const PAGE_TTL = 10 * 60_000;

/** One page of search results, or of what's trending when the query is empty. */
export async function searchGifs(key: string, q: string, page: number, signal?: AbortSignal): Promise<GifPage> {
  const ru = getLocale() === "ru";
  const id = `${key}|${ru}|${q.toLowerCase()}|${page}`;
  const hit = pages.get(id);
  if (hit && Date.now() - hit.at < PAGE_TTL) return hit.page;
  const params = { page, per_page: 24, customer_id: customerId(), locale: ru ? "ru" : "us" };
  const j = await klipy<{ data?: { data?: KlipyItem[]; has_next?: boolean } }>(key, q ? "gifs/search" : "gifs/trending", q ? { ...params, q } : params, signal);
  // Order and composition stay exactly as the provider returned them.
  const items = (j.data?.data ?? []).map(toGif).filter((g): g is GifDTO => !!g);
  const out = { items, more: !!j.data?.has_next && items.length > 0 };
  pages.set(id, { at: Date.now(), page: out });
  if (pages.size > 60) pages.delete(pages.keys().next().value!);
  return out;
}

export interface GifCategory {
  label: string;
  query: string;
}

const CATEGORY_TTL = 24 * 3600_000;

export async function gifCategories(key: string): Promise<GifCategory[]> {
  const locale = getLocale() === "ru" ? "ru_RU" : "en_US";
  const store = `nova.gifCategories.${locale}`;
  try {
    const saved = JSON.parse(localStorage.getItem(store) ?? "null") as { at: number; list: GifCategory[] } | null;
    if (saved && Date.now() - saved.at < CATEGORY_TTL && saved.list.length) return saved.list;
  } catch {
    /* ask again */
  }
  const j = await klipy<{ data?: { categories?: { category?: string; query?: string }[] } }>(key, "gifs/categories", { locale });
  const list = (j.data?.categories ?? []).filter((c) => c.category && c.query).map((c) => ({ label: c.category!, query: c.query! }));
  try {
    localStorage.setItem(store, JSON.stringify({ at: Date.now(), list }));
  } catch {
    /* not essential */
  }
  return list;
}

/** Does KLIPY accept this key? (Asked from the admin panel before saving.) */
export async function checkGifKey(key: string): Promise<"ok" | GifFailure> {
  try {
    await klipy(key, "gifs/trending", { page: 1, per_page: 8, customer_id: customerId() });
    return "ok";
  } catch (e) {
    return e instanceof GifError ? e.reason : "network";
  }
}

/** Tells the provider a GIF was sent — it ranks results by what people actually use. */
function reportShare(gif: GifDTO, q: string) {
  if (!gif.slug || !config?.value.key) return;
  void fetch(`${KLIPY}/${encodeURIComponent(config.value.key)}/gifs/share/${encodeURIComponent(gif.slug)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ customer_id: customerId(), q }),
    keepalive: true,
  }).catch(() => {});
}

// ── favourites + recent ──────────────────────────────────────────────────────
const RECENT_KEY = "nova.gifRecent";
const RECENT_MAX = 30;

function readRecent(): GifDTO[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as GifDTO[];
    return Array.isArray(list) ? list.filter((g) => g && typeof g.url === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

interface GifState {
  favorites: GifDTO[];
  /** null — not asked yet. */
  loaded: boolean | null;
  /** false — the server is older than 1.2 and can't keep favourites. */
  supported: boolean;
  recent: GifDTO[];
}

export const useGifs = create<GifState>(() => ({ favorites: [], loaded: null, supported: true, recent: readRecent() }));

export async function loadFavorites() {
  try {
    const favorites = await api<GifDTO[]>("/api/users/@me/gifs");
    useGifs.setState({ favorites, loaded: true, supported: true });
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) useGifs.setState({ favorites: [], loaded: true, supported: false });
    else useGifs.setState((s) => ({ loaded: s.loaded ?? false }));
  }
}

/** Signed out, or another account signed in: nothing of the previous one stays. */
export function resetGifs() {
  forgetGifConfig();
  useGifs.setState({ favorites: [], loaded: null, supported: true });
}

export function onGifsEvent(d: { added?: GifDTO; removed?: string }) {
  useGifs.setState((s) => {
    let favorites = s.favorites;
    if (d.removed) favorites = favorites.filter((g) => g.url !== d.removed);
    if (d.added) favorites = [d.added, ...favorites.filter((g) => g.url !== d.added!.url)];
    return { favorites };
  });
}

export const isFavorite = (s: GifState, url: string) => s.favorites.some((g) => g.url === url);

export interface GifRef {
  url: string;
  preview?: string | null;
  width?: number | null;
  height?: number | null;
}

/** Star / unstar. The list changes at once; a refusal puts it back. */
export async function toggleFavorite(gif: GifRef) {
  const before = useGifs.getState().favorites;
  const on = !before.some((g) => g.url === gif.url);
  const entry: GifDTO = { id: gif.url, url: gif.url, preview: gif.preview || gif.url, width: gif.width ?? null, height: gif.height ?? null };
  onGifsEvent(on ? { added: entry } : { removed: gif.url });
  try {
    if (on) await api("/api/users/@me/gifs", { method: "PUT", body: { url: gif.url, preview: gif.preview || null, width: gif.width ?? null, height: gif.height ?? null } });
    else await api("/api/users/@me/gifs", { method: "DELETE", query: { url: gif.url } });
  } catch (e) {
    useGifs.setState({ favorites: before });
    toast(errorText(e), "error");
  }
}

// ── sending ──────────────────────────────────────────────────────────────────
/** Sizes of GIFs sent from the picker: the message can be laid out before the server's preview arrives. */
const sizes = new Map<string, { width: number; height: number }>();
export const knownGifSize = (url: string) => sizes.get(url) ?? null;

/** The link that goes into the message: uploaded GIFs are paths on this server and need its address. */
export const gifLink = (gif: GifDTO) => (gif.url.startsWith("/") ? webLink(gif.url) : gif.url);

/** Bookkeeping after a GIF went out: recent list, its size, and the provider's share counter. */
export function gifSent(gif: GifDTO, query = "") {
  if (gif.width && gif.height) sizes.set(gifLink(gif), { width: gif.width, height: gif.height });
  const recent = [gif, ...useGifs.getState().recent.filter((g) => g.url !== gif.url)].slice(0, RECENT_MAX);
  useGifs.setState({ recent });
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {
    /* this device only — fine to lose */
  }
  reportShare(gif, query);
}

// ── showing ──────────────────────────────────────────────────────────────────
const IMAGE_PATH_RE = /\.(gif|webp|png|jpe?g|avif)$/i;

/** A message that is nothing but one link. */
export function loneUrl(content: string): string | null {
  const s = content.trim();
  return /^https?:\/\/\S+$/i.test(s) ? s : null;
}

const ownOrigin = () => {
  try {
    return new URL(serverBase() || location.origin).origin;
  } catch {
    return location.origin;
  }
};

/** A file uploaded to this server, as the path it is stored under — or null for anything else. */
export function ownFilePath(url: string): string | null {
  if (url.startsWith("/files/")) return url;
  try {
    const u = new URL(url);
    return u.origin === ownOrigin() && u.pathname.startsWith("/files/") ? u.pathname : null;
  } catch {
    return null;
  }
}

export function isProviderMedia(url: string): boolean {
  try {
    return PROVIDER_MEDIA_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Links the app can show as a picture at once, without waiting for the
 * server's preview: the provider's CDN and images on this server. `key` is
 * what favourites store.
 */
export function instantGif(url: string): { src: string; key: string } | null {
  const own = ownFilePath(url);
  if (own) return IMAGE_PATH_RE.test(own) ? { src: own, key: own } : null;
  if (!isProviderMedia(url)) return null;
  return IMAGE_PATH_RE.test(new URL(url).pathname) ? { src: url, key: url } : null;
}

/** Does this link point at something animated worth a star? */
export function looksLikeGif(url: string): boolean {
  if (isProviderMedia(url)) return true;
  try {
    return /\.gif$/i.test(new URL(url, location.origin).pathname);
  } catch {
    return false;
  }
}
