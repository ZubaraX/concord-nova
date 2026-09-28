// Preferences. "Synced" ones follow the account across devices (stored on the
// server, pushed debounced); "local" ones are device-specific (audio devices,
// volumes, hotkeys) and live in localStorage.
import { create } from "zustand";
import { api } from "../lib/api";
import { setLocale, type Locale } from "../lib/i18n";
import { setUse24h } from "../lib/time";

export type Theme = "nova" | "aurora" | "ember" | "graphite" | "oled" | "daylight";
export type Effects = "full" | "lite" | "off";

export interface SyncedSettings {
  theme: Theme;
  accent: string | null;
  density: "cozy" | "compact";
  fontScale: number;
  effects: Effects;
  locale: Locale;
  use24h: boolean;
  sendOnEnter: boolean;
  animateEmoji: boolean;
  showEmbeds: boolean;
  developerMode: boolean;
  sounds: boolean;
  guildOrder: string[];
  recentEmoji: string[];
}

export interface LocalSettings {
  inputDevice: string | null;
  outputDevice: string | null;
  videoDevice: string | null;
  inputVolume: number;
  outputVolume: number;
  inputMode: "vad" | "ptt";
  pttKey: string;
  pttReleaseMs: number;
  sensitivityAuto: boolean;
  /** dBFS threshold for voice activation when not automatic. */
  sensitivityDb: number;
  noise: "rnnoise" | "standard" | "off";
  echoCancellation: boolean;
  autoGain: boolean;
  screenQuality: "720p30" | "1080p30" | "1080p60" | "1440p60" | "source";
  joinMuted: boolean;
  userVolumes: Record<string, number>;
  streamVolumes: Record<string, number>;
  localMutes: Record<string, boolean>;
  desktopNotifications: boolean;
  flashTaskbar: boolean;
  unreadBadge: boolean;
  autostart: boolean;
  minimizeToTray: boolean;
  overlay: boolean;
  keybinds: Record<string, string>;
  lastChannels: Record<string, string>;
  memberListOpen: boolean;
  skinTone: number;
}

const SYNC_DEFAULTS: SyncedSettings = {
  theme: "nova",
  accent: null,
  density: "cozy",
  fontScale: 1,
  effects: "full",
  locale: (navigator.language ?? "ru").toLowerCase().startsWith("en") ? "en" : "ru",
  use24h: true,
  sendOnEnter: true,
  animateEmoji: true,
  showEmbeds: true,
  developerMode: false,
  sounds: true,
  guildOrder: [],
  recentEmoji: [],
};

const LOCAL_DEFAULTS: LocalSettings = {
  inputDevice: null,
  outputDevice: null,
  videoDevice: null,
  inputVolume: 100,
  outputVolume: 100,
  inputMode: "vad",
  pttKey: "Backquote",
  pttReleaseMs: 200,
  sensitivityAuto: true,
  sensitivityDb: -50,
  noise: "rnnoise",
  echoCancellation: true,
  autoGain: true,
  screenQuality: "1080p30",
  joinMuted: false,
  userVolumes: {},
  streamVolumes: {},
  localMutes: {},
  desktopNotifications: true,
  flashTaskbar: true,
  unreadBadge: true,
  autostart: false,
  minimizeToTray: true,
  overlay: false,
  keybinds: { toggleMute: "Ctrl+Shift+M", toggleDeafen: "Ctrl+Shift+D" },
  lastChannels: {},
  memberListOpen: true,
  skinTone: 0,
};

const LOCAL_KEY = "nova.settings.local";
const SYNC_KEY = "nova.settings.synced";

function load<T extends object>(key: string, defaults: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...defaults, ...JSON.parse(raw) } : { ...defaults };
  } catch {
    return { ...defaults };
  }
}

interface SettingsState extends SyncedSettings, LocalSettings {
  setSynced: (p: Partial<SyncedSettings>) => void;
  setLocal: (p: Partial<LocalSettings>) => void;
  /** Apply settings that arrived from the server (READY / other device). */
  hydrateSynced: (remote: Record<string, unknown>) => void;
}

let pushTimer: ReturnType<typeof setTimeout> | null = null;
let suppressPush = false;

function syncedOf(s: SyncedSettings): SyncedSettings {
  const out = {} as Record<string, unknown>;
  for (const k of Object.keys(SYNC_DEFAULTS)) out[k] = (s as unknown as Record<string, unknown>)[k];
  return out as unknown as SyncedSettings;
}

export const useSettings = create<SettingsState>((set, get) => ({
  ...load(SYNC_KEY, SYNC_DEFAULTS),
  ...load(LOCAL_KEY, LOCAL_DEFAULTS),
  setSynced(p) {
    set(p);
    const synced = syncedOf(get());
    try {
      localStorage.setItem(SYNC_KEY, JSON.stringify(synced));
    } catch {
      /* quota */
    }
    applyVisuals();
    if (suppressPush) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      void api("/api/users/@me/settings", { method: "PUT", body: syncedOf(get()) }).catch(() => {});
    }, 800);
  },
  setLocal(p) {
    set(p);
    const local = {} as Record<string, unknown>;
    for (const k of Object.keys(LOCAL_DEFAULTS)) local[k] = (get() as unknown as Record<string, unknown>)[k];
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(local));
    } catch {
      /* quota */
    }
  },
  hydrateSynced(remote) {
    if (!remote || !Object.keys(remote).length) {
      // First login on this account: upload what this device has.
      void api("/api/users/@me/settings", { method: "PUT", body: syncedOf(get()) }).catch(() => {});
      return;
    }
    suppressPush = true;
    const clean: Partial<SyncedSettings> = {};
    for (const k of Object.keys(SYNC_DEFAULTS) as (keyof SyncedSettings)[]) if (k in remote) (clean as Record<string, unknown>)[k] = remote[k];
    get().setSynced(clean);
    suppressPush = false;
  },
}));

export const settings = () => useSettings.getState();

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Push theme/density/effects/font/locale onto <html>. */
export function applyVisuals() {
  const s = useSettings.getState();
  const el = document.documentElement;
  if (el.dataset.theme !== s.theme) {
    el.classList.add("theme-fade");
    el.dataset.theme = s.theme;
    setTimeout(() => el.classList.remove("theme-fade"), 400);
  }
  el.classList.toggle("fx-full", s.effects === "full");
  el.classList.toggle("fx-lite", s.effects === "lite");
  el.classList.toggle("fx-off", s.effects === "off");
  el.classList.toggle("compact", s.density === "compact");
  el.style.setProperty("--font-scale", String(s.fontScale || 1));
  const rgb = s.accent ? hexToRgb(s.accent) : null;
  if (rgb) {
    el.style.setProperty("--star", rgb.join(" "));
    el.style.setProperty("--star-2", rgb.map((v) => Math.round(v * 0.82)).join(" "));
    const lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
    el.style.setProperty("--on-star", lum > 0.6 ? "24 18 4" : "255 255 255");
  } else {
    el.style.removeProperty("--star");
    el.style.removeProperty("--star-2");
    el.style.removeProperty("--on-star");
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  const canvas = getComputedStyle(el).getPropertyValue("--canvas").trim().split(/\s+/).map(Number);
  if (meta && canvas.length === 3) meta.setAttribute("content", `rgb(${canvas.join(",")})`);
  setLocale(s.locale);
  setUse24h(s.use24h);
}
