// Preferences. "Synced" ones follow the account across devices (stored on the
// server, pushed debounced); "local" ones are device-specific (audio devices,
// volumes, hotkeys) and live in localStorage.
import { create } from "zustand";
import { api } from "../lib/api";
import { setLocale, type Locale } from "../lib/i18n";
import { setUse24h } from "../lib/time";
import type { EffectId } from "../features/voice/effects";

/** "custom": surfaces and text are derived from one colour the user picks (themeColor). */
export type Theme = "nova" | "aurora" | "ember" | "graphite" | "oled" | "daylight" | "custom";
export type Effects = "full" | "lite" | "off";

export interface SyncedSettings {
  theme: Theme;
  /** Base colour of the custom theme (any colour: dark picks make a dark theme, light picks a light one). */
  themeColor: string;
  accent: string | null;
  /** Chat background: "none", an animated preset (components/ui/cosmetics BACKDROPS) or "custom" (a file on this device). */
  wallpaper: string;
  /** How much the wallpaper is dimmed under the messages, 0–90 %. */
  wallpaperDim: number;
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
  /** Hang up after a minute alone in a call: everywhere, only in DM/group calls, or never. */
  autoLeave: "always" | "calls" | "never";
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
  /** deep: DeepFilterNet3, rnnoise: the lighter model, standard: the browser's own, off. */
  noise: "deep" | "rnnoise" | "standard" | "off";
  /** Voice changer preset (features/voice/effects). */
  /** A built-in effect or "custom:<preset id>". */
  voiceEffect: EffectId;
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
  /** Incoming-call melody: a built-in one (lib/sound RINGTONES) or "custom" (the user's file). */
  ringtone: string;
  /** File name of the custom ringtone, for display. */
  ringtoneName: string | null;
  /** File name of the custom chat wallpaper (the file itself is in IndexedDB). */
  wallpaperName: string | null;
  /** Version of the one-time local upgrades applied (see the end of this file). */
  localVersion: number;
}

const SYNC_DEFAULTS: SyncedSettings = {
  theme: "nova",
  themeColor: "#2b3a67",
  accent: null,
  wallpaper: "none",
  wallpaperDim: 35,
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
  autoLeave: "always",
  guildOrder: [],
  recentEmoji: [],
};

export const DEFAULT_KEYBINDS: Record<string, string> = {
  toggleMute: "Ctrl+Shift+Alt+M",
  toggleDeafen: "Ctrl+Shift+Alt+D",
  toggleOverlay: "Ctrl+Shift+Alt+O",
};

/** What the desktop app registers system-wide ("" / null = not bound). */
export function globalShortcutMap(k: Record<string, string> = useSettings.getState().keybinds): Record<string, string | null> {
  return { toggleMute: k.toggleMute || null, toggleDeafen: k.toggleDeafen || null, toggleOverlay: k.toggleOverlay || null };
}

/** The way a pressed key is written in settings: "Ctrl+Shift+Alt+M". */
export function comboOf(e: KeyboardEvent): string {
  return [e.ctrlKey && "Ctrl", e.shiftKey && "Shift", e.altKey && "Alt", e.metaKey && "Super", e.code.replace(/^Key|^Digit/, "")].filter(Boolean).join("+");
}

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
  // The strong model on computers; phones start with the lighter one.
  noise: /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ? "rnnoise" : "deep",
  voiceEffect: "none",
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
  // Three modifiers: games practically never use them, so a hotkey isn't hit mid-game by accident.
  keybinds: { ...DEFAULT_KEYBINDS },
  lastChannels: {},
  memberListOpen: true,
  skinTone: 0,
  ringtone: "nova",
  ringtoneName: null,
  wallpaperName: null,
  localVersion: 0,
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

// When the synced settings last changed on this device. Stored with them (as
// `_ts`, locally and on the server) so a stale copy never overwrites a newer
// one — e.g. READY arriving right after a change that hadn't been pushed yet.
let changedAt = (() => {
  try {
    return Number(JSON.parse(localStorage.getItem(SYNC_KEY) ?? "{}")._ts) || 0;
  } catch {
    return 0;
  }
})();

const payload = () => ({ ...syncedOf(useSettings.getState()), _ts: changedAt });

function pushNow(keepalive = false) {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = null;
  void api("/api/users/@me/settings", { method: "PUT", body: payload(), keepalive }).catch(() => {});
}

// Closing the window within the debounce must not lose the last change.
if (typeof window !== "undefined") window.addEventListener("pagehide", () => pushTimer && pushNow(true));

export const useSettings = create<SettingsState>((set, get) => ({
  ...load(SYNC_KEY, SYNC_DEFAULTS),
  ...load(LOCAL_KEY, LOCAL_DEFAULTS),
  setSynced(p) {
    set(p);
    if (!suppressPush) changedAt = Date.now();
    try {
      localStorage.setItem(SYNC_KEY, JSON.stringify({ ...syncedOf(get()), _ts: changedAt }));
    } catch {
      /* quota */
    }
    applyVisuals();
    if (suppressPush) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => pushNow(), 800);
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
    const remoteAt = Number(remote?._ts) || 0;
    // First login on this account, or this device changed something more
    // recently than the server copy: this device wins and uploads its copy.
    if (!remote || !Object.keys(remote).length || changedAt > remoteAt || pushTimer) {
      pushNow();
      return;
    }
    suppressPush = true;
    changedAt = remoteAt;
    const clean: Partial<SyncedSettings> = {};
    for (const k of Object.keys(SYNC_DEFAULTS) as (keyof SyncedSettings)[]) if (k in remote) (clean as Record<string, unknown>)[k] = remote[k];
    get().setSynced(clean);
    suppressPush = false;
  },
}));

export const settings = () => useSettings.getState();

const IS_PHONE = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
/** The denoiser the noise button switches on: the strong model on computers, the light one on phones. */
export const preferredDenoiser = (): "deep" | "rnnoise" => (IS_PHONE ? "rnnoise" : "deep");

// One-time upgrades of device-local settings.
{
  const s = useSettings.getState();
  // v1: RNNoise used to be the only neural option (and the default). Computers move to DeepFilterNet3.
  if (s.localVersion < 1) s.setLocal({ localVersion: 1, ...(s.noise === "rnnoise" ? { noise: preferredDenoiser() } : {}) });
  // v2: the old default hotkeys (Ctrl+Shift+M / D) were hit in games — move them to the new ones unless they were changed.
  if (useSettings.getState().localVersion < 2) {
    const k = { ...useSettings.getState().keybinds };
    if (!k.toggleMute || k.toggleMute === "Ctrl+Shift+M") k.toggleMute = DEFAULT_KEYBINDS.toggleMute;
    if (!k.toggleDeafen || k.toggleDeafen === "Ctrl+Shift+D") k.toggleDeafen = DEFAULT_KEYBINDS.toggleDeafen;
    if (!k.toggleOverlay) k.toggleOverlay = DEFAULT_KEYBINDS.toggleOverlay;
    useSettings.getState().setLocal({ localVersion: 2, keybinds: k });
  }
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

function hsl(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255);
  };
  return `${f(0)} ${f(8)} ${f(4)}`;
}

/**
 * A whole theme from one colour: its hue tints every surface, its lightness
 * decides between a dark and a light theme. Text and lines keep enough contrast
 * whatever is picked.
 */
export function customThemeVars(hex: string): Record<string, string> {
  const [h, sRaw, l] = rgbToHsl(...(hexToRgb(hex) ?? [43, 58, 103]));
  if (l > 0.6) {
    const s = Math.min(sRaw, 0.55);
    const base = Math.min(0.95, Math.max(0.86, l));
    return {
      "color-scheme": "light",
      "--canvas": hsl(h, s * 0.55, base - 0.05),
      "--panel": hsl(h, s * 0.5, base - 0.015),
      "--surface": hsl(h, s * 0.45, Math.min(0.985, base + 0.03)),
      "--raised": hsl(h, s * 0.5, base - 0.085),
      "--overlay": hsl(h, s * 0.5, base - 0.15),
      "--line": hsl(h, 0.35, 0.24),
      "--fg": hsl(h, 0.35, 0.11),
      "--fg-2": hsl(h, 0.2, 0.32),
      "--fg-3": hsl(h, 0.14, 0.46),
      "--sky-glow": hsl((h + 40) % 360, 0.55, 0.7),
    };
  }
  const s = Math.min(sRaw, 0.6);
  const base = Math.min(0.13, Math.max(0.035, l * 0.3));
  return {
    "color-scheme": "dark",
    "--canvas": hsl(h, s * 0.75, base),
    "--panel": hsl(h, s * 0.7, base + 0.03),
    "--surface": hsl(h, s * 0.68, base + 0.055),
    "--raised": hsl(h, s * 0.62, base + 0.105),
    "--overlay": hsl(h, s * 0.58, base + 0.17),
    "--line": hsl(h, 0.55, 0.78),
    "--fg": hsl(h, 0.25, 0.93),
    "--fg-2": hsl(h, 0.2, 0.72),
    "--fg-3": hsl(h, 0.16, 0.53),
    "--sky-glow": hsl((h + 40) % 360, 0.5, 0.45),
  };
}
const CUSTOM_KEYS = Object.keys(customThemeVars("#000000"));

/** Push theme/density/effects/font/locale onto <html>. */
export function applyVisuals() {
  const s = useSettings.getState();
  const el = document.documentElement;
  if (el.dataset.theme !== s.theme) {
    el.classList.add("theme-fade");
    el.dataset.theme = s.theme;
    setTimeout(() => el.classList.remove("theme-fade"), 400);
  }
  if (s.theme === "custom") for (const [k, v] of Object.entries(customThemeVars(s.themeColor))) el.style.setProperty(k, v);
  else for (const k of CUSTOM_KEYS) el.style.removeProperty(k);
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
