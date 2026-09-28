// Bridges to the native Android plugins (client/android-extras): background
// push service (no Google FCM), MediaProjection screen capture, speakerphone,
// share-target and invite links.
import { Capacitor, CapacitorHttp, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { api } from "./api";
import { serverBase } from "./server";
import { isAndroid } from "./platform";

/** Shared from another app: files were copied into the app cache by the native side. */
export type SharedContent = { text?: string; files?: { path: string; name: string; mimeType: string }[] };
type OpenEvent = { channelId: string; accept?: boolean };

interface NovaNativePlugin {
  startPush(opts: { url: string; token: string }): Promise<void>;
  stopPush(): Promise<void>;
  batteryExempt(opts: { prompt: boolean }): Promise<{ granted: boolean }>;
  setSpeakerphone(opts: { on: boolean }): Promise<void>;
  setProximity(opts: { on: boolean }): Promise<void>;
  getPending(): Promise<{ share?: SharedContent; invite?: { code: string }; channel?: OpenEvent }>;
  addListener(event: "share", cb: (d: SharedContent) => void): Promise<PluginListenerHandle>;
  addListener(event: "invite", cb: (d: { code: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: "open", cb: (d: OpenEvent) => void): Promise<PluginListenerHandle>;
}

interface ScreenCapPlugin {
  start(opts: { maxDim: number; fps: number; quality: number }): Promise<void>;
  stop(): Promise<void>;
  addListener(event: "frame", cb: (d: { b64: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: "stopped", cb: () => void): Promise<PluginListenerHandle>;
}

const Native = registerPlugin<NovaNativePlugin>("NovaNative");
const ScreenCap = registerPlugin<ScreenCapPlugin>("ScreenCap");

// ── updates ──────────────────────────────────────────────────────────────────
/** 1.2.3 (+ CI build number) as one comparable number. */
const rank = (version: string, build: number) => version.split(".").reduce((n, p) => n * 1000 + (parseInt(p, 10) || 0), 0) * 100_000 + build;

/**
 * A sideloaded APK never updates itself: compare with the build CI published
 * (android-latest.json next to the APK) and return it when it's newer. Fetched
 * natively — the GitHub download host sends no CORS headers.
 */
export async function newerAndroidBuild(): Promise<{ version: string; url: string } | null> {
  const feed = import.meta.env.VITE_ANDROID_UPDATE_URL;
  if (!isAndroid || !feed) return null;
  try {
    const r = await CapacitorHttp.get({ url: feed, responseType: "json" });
    const d = (typeof r.data === "string" ? JSON.parse(r.data) : r.data) as { version?: string; build?: number; url?: string };
    if (r.status !== 200 || !d?.version || !d.url) return null;
    return rank(d.version, d.build ?? 0) > rank(__APP_VERSION__, __APP_BUILD__) ? { version: d.version, url: d.url } : null;
  } catch {
    return null;
  }
}

export async function startPush() {
  if (!isAndroid) return;
  try {
    const { token } = await api<{ token: string }>("/api/push/token", { method: "POST" });
    await Native.startPush({ url: serverBase(), token });
    // Aggressive battery savers kill the push link; ask once to be exempted.
    if (!localStorage.getItem("nova.batteryAsked")) {
      localStorage.setItem("nova.batteryAsked", "1");
      await Native.batteryExempt({ prompt: true });
    }
  } catch (e) {
    console.warn("[push] not started", e);
  }
}

export async function stopPush() {
  if (!isAndroid) return;
  await Native.stopPush().catch(() => {});
}

export const setSpeakerphone = (on: boolean) => (isAndroid ? Native.setSpeakerphone({ on }).catch(() => {}) : undefined);
export const setProximity = (on: boolean) => (isAndroid ? Native.setProximity({ on }).catch(() => {}) : undefined);

export function initAndroidIntents(handlers: {
  share: (s: SharedContent) => void;
  invite: (code: string) => void;
  open: (channelId: string, accept: boolean) => void;
}) {
  if (!isAndroid) return;
  const share = (d: SharedContent) => (d.text || d.files?.length) && handlers.share(d);
  // Listeners first, then drain what arrived before the WebView subscribed (bridge calls run in order).
  void Native.addListener("share", share);
  void Native.addListener("invite", (d) => d.code && handlers.invite(d.code));
  void Native.addListener("open", (d) => d.channelId && handlers.open(d.channelId, !!d.accept));
  void Native.getPending()
    .then((p) => {
      if (p.share) share(p.share);
      if (p.invite?.code) handlers.invite(p.invite.code);
      if (p.channel?.channelId) handlers.open(p.channel.channelId, !!p.channel.accept);
    })
    .catch(() => {});
}

/** Loads shared files through Capacitor's local file server (no base64 over the bridge). */
export async function sharedFiles(s: SharedContent): Promise<File[]> {
  const out: File[] = [];
  for (const f of s.files ?? []) {
    try {
      const blob = await (await fetch(Capacitor.convertFileSrc(f.path))).blob();
      out.push(new File([blob], f.name, { type: f.mimeType || blob.type }));
    } catch (e) {
      console.warn("[share] failed to read", f.name, e);
    }
  }
  return out;
}

// ── screen capture: native JPEG frames → canvas → WebRTC track ──────────────
let canvas: HTMLCanvasElement | null = null;
let subs: PluginListenerHandle[] = [];

export async function startScreenCapture(onEnded: () => void): Promise<MediaStreamTrack> {
  canvas = document.createElement("canvas");
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext("2d", { alpha: false })!;
  let busy = false;
  const frame = await ScreenCap.addListener("frame", ({ b64 }) => {
    if (busy || !canvas) return;
    busy = true;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    createImageBitmap(new Blob([bytes], { type: "image/jpeg" }))
      .then((bmp) => {
        if (canvas) {
          if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
            canvas.width = bmp.width;
            canvas.height = bmp.height;
          }
          ctx.drawImage(bmp, 0, 0);
        }
        bmp.close();
      })
      .catch(() => {})
      .finally(() => {
        busy = false;
      });
  });
  const stopped = await ScreenCap.addListener("stopped", onEnded);
  subs = [frame, stopped];
  try {
    await ScreenCap.start({ maxDim: 1280, fps: 12, quality: 60 });
  } catch (e) {
    await stopScreenCapture();
    throw e;
  }
  return canvas.captureStream(15).getVideoTracks()[0];
}

export async function stopScreenCapture() {
  await ScreenCap.stop().catch(() => {});
  subs.forEach((s) => void s.remove());
  subs = [];
  canvas = null;
}
