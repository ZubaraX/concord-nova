// HTTP client: bearer auth, proactive + reactive token refresh (single flight,
// so parallel requests never race each other), typed errors with the server's
// stable error codes, and uploads with progress.
import type { AttachmentDTO, SoundDTO } from "@nova/shared";
import { apiUrl, switchToFallback } from "./server";
import { platform } from "./platform";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public fields?: Record<string, string>,
    public retryAfter?: number
  ) {
    super(message ?? code);
  }
  get isNetwork() {
    return this.status === 0;
  }
}

const ACCESS = "nova.access";
const REFRESH = "nova.refresh";

function read(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

export const tokens = {
  get access() {
    return read(ACCESS);
  },
  get refresh() {
    return read(REFRESH);
  },
  set(access: string, refresh?: string) {
    localStorage.setItem(ACCESS, access);
    if (refresh) localStorage.setItem(REFRESH, refresh);
  },
  clear() {
    localStorage.removeItem(ACCESS);
    localStorage.removeItem(REFRESH);
  },
};

// ── auth-lost signal (session revoked / refresh rejected) ────────────────────
type Listener = (reason: string) => void;
const lostListeners = new Set<Listener>();
export function onAuthLost(fn: Listener) {
  lostListeners.add(fn);
  return () => lostListeners.delete(fn);
}
function authLost(reason: string) {
  tokens.clear();
  for (const fn of lostListeners) fn(reason);
}

function expSeconds(jwt: string | null): number {
  if (!jwt) return 0;
  try {
    const payload = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof payload.exp === "number" ? payload.exp : 0;
  } catch {
    return 0;
  }
}

let refreshing: Promise<string | null> | null = null;

/** Get a new access token. Null = no session (auth lost). Throws on network errors. */
export function refreshAccess(): Promise<string | null> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const refresh = tokens.refresh;
    if (!refresh) return null;
    let res: Response;
    try {
      res = await fetch(apiUrl("/api/auth/refresh"), {
        method: "POST",
        headers: { "content-type": "application/json", "x-nova-platform": platform },
        body: JSON.stringify({ refreshToken: refresh }),
      });
    } catch {
      throw new ApiError(0, "network_error");
    }
    if (res.status === 401 || res.status === 400) {
      authLost("refresh_rejected");
      return null;
    }
    if (!res.ok) throw new ApiError(res.status, "refresh_failed");
    const body = (await res.json()) as { accessToken: string };
    tokens.set(body.accessToken);
    return body.accessToken;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** Access token that stays valid for at least the next minute. */
export async function freshToken(): Promise<string | null> {
  const t = tokens.access;
  if (t && expSeconds(t) - Date.now() / 1000 > 60) return t;
  if (!tokens.refresh) return t;
  return refreshAccess();
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  auth?: boolean;
  /** Survives page unload (for last-moment saves). */
  keepalive?: boolean;
}

function withQuery(path: string, q?: RequestOptions["query"]) {
  if (!q) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  const s = params.toString();
  return s ? `${path}${path.includes("?") ? "&" : "?"}${s}` : path;
}

async function toError(res: Response): Promise<ApiError> {
  let body: { error?: { code?: string; message?: string; fields?: Record<string, string>; retryAfter?: number } } = {};
  try {
    body = await res.json();
  } catch {
    /* no json body */
  }
  const retry = Number(res.headers.get("retry-after")) || body.error?.retryAfter;
  return new ApiError(res.status, body.error?.code ?? `http_${res.status}`, body.error?.message, body.error?.fields, retry || undefined);
}

let switchedOnce = false;

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, query, signal, auth = true, keepalive } = opts;
  const doFetch = async (token: string | null) => {
    const headers: Record<string, string> = { "x-nova-platform": platform };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (auth && token) headers.authorization = `Bearer ${token}`;
    return fetch(apiUrl(withQuery(path, query)), { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal, keepalive });
  };

  let token = auth ? await freshToken().catch(() => tokens.access) : null;
  let res: Response;
  try {
    res = await doFetch(token);
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    // Network-level failure: try the fallback base once per session (only if
    // the current address is really unreachable — see switchToFallback).
    if (!switchedOnce && (await switchToFallback())) {
      switchedOnce = true;
      try {
        res = await doFetch(token);
      } catch {
        throw new ApiError(0, "network_error");
      }
    } else throw new ApiError(0, "network_error");
  }

  if (res.status === 401 && auth) {
    const err = await toError(res);
    if (err.code === "invalid_token" || err.code === "missing_token") {
      token = await refreshAccess();
      if (!token) throw err;
      res = await doFetch(token);
      if (res.status === 401) {
        authLost("unauthorized");
        throw await toError(res);
      }
    } else {
      authLost(err.code);
      throw err;
    }
  }
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// ── uploads ──────────────────────────────────────────────────────────────────
export interface UploadOptions {
  query?: Record<string, string | number | undefined>;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

function xhrUpload<T>(path: string, file: Blob, filename: string, opts: UploadOptions, token: string | null): Promise<{ status: number; body: T | null; raw: string; retry: number }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", apiUrl(withQuery(path, opts.query)));
    if (token) xhr.setRequestHeader("authorization", `Bearer ${token}`);
    xhr.setRequestHeader("x-nova-platform", platform);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: T | null = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* not json */
      }
      resolve({ status: xhr.status, body, raw: xhr.responseText, retry: Number(xhr.getResponseHeader("retry-after")) || 0 });
    };
    xhr.onerror = () => reject(new ApiError(0, "network_error"));
    xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
    opts.signal?.addEventListener("abort", () => xhr.abort());
    const form = new FormData();
    form.append("file", file, filename);
    xhr.send(form);
  });
}

async function uploadTo<T>(path: string, file: Blob, filename: string, opts: UploadOptions = {}): Promise<T> {
  let token = await freshToken().catch(() => tokens.access);
  let r = await xhrUpload<T>(path, file, filename, opts, token);
  if (r.status === 401) {
    token = await refreshAccess();
    if (!token) throw new ApiError(401, "unauthorized");
    r = await xhrUpload<T>(path, file, filename, opts, token);
  }
  if (r.status < 200 || r.status >= 300) {
    const e = (r.body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(r.status, e?.code ?? `http_${r.status}`, e?.message, undefined, r.retry || undefined);
  }
  return r.body as T;
}

export const uploadAttachment = (file: Blob, filename: string, opts?: UploadOptions) => uploadTo<AttachmentDTO>("/api/attachments", file, filename, opts);

export const uploadImage = (file: Blob, kind: "avatar" | "banner" | "icon" | "guild_banner" | "group_icon" | "sound_icon") =>
  uploadTo<{ url: string; animated: boolean }>("/api/images", file, (file as File).name || "image", { query: { kind } });

/** A soundboard sound: the audio as the file, its name, emoji or icon and target server in the query. */
export const uploadSound = (file: Blob, filename: string, meta: { name: string; emoji?: string; image?: string; guildId?: string }) =>
  uploadTo<SoundDTO>("/api/sounds", file, filename, { query: meta });

export const uploadEmoji = (guildId: string, file: Blob, name: string) => uploadTo(`/api/guilds/${guildId}/emojis`, file, (file as File).name || "emoji", { query: { name } });
