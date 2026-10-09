// Screen-share quality: presets from economical to extreme, and a custom one.
// A preset is a capture size, a frame rate, a bitrate ceiling, a codec and
// what to give up first when bandwidth or the encoder can't keep up:
// - "detail": keep the picture sharp, drop frames (text, code, documents);
// - "motion": keep the frames, lower the resolution (games, video);
// - "balanced": a bit of both.
// (Until 1.7.5 the top was 1080p at 4.5 Mbit/s with H.264 only: fast game
// footage broke up into blur.)
import type { ScreenCustom } from "../../store/settings";

export type ScreenCodec = "h264" | "vp9" | "av1";
export type ScreenMode = "detail" | "balanced" | "motion";

export interface ScreenPreset {
  /** Capture height (0 = the screen's own size); the width follows the screen's shape. */
  height: number;
  fps: number;
  /** Bits per second, at most. */
  bitrate: number;
  codec: ScreenCodec;
  mode: ScreenMode;
}

export const SCREEN_PRESET_IDS = ["low", "standard", "sharp", "games", "gamesPlus", "ultra", "extreme"] as const;
export type ScreenPresetId = (typeof SCREEN_PRESET_IDS)[number];

export const SCREEN_PRESETS: Record<ScreenPresetId, ScreenPreset> = {
  low: { height: 720, fps: 30, bitrate: 2_000_000, codec: "h264", mode: "balanced" },
  standard: { height: 1080, fps: 30, bitrate: 5_000_000, codec: "h264", mode: "balanced" },
  sharp: { height: 1440, fps: 30, bitrate: 8_000_000, codec: "h264", mode: "detail" },
  games: { height: 1080, fps: 60, bitrate: 10_000_000, codec: "h264", mode: "motion" },
  gamesPlus: { height: 1440, fps: 60, bitrate: 16_000_000, codec: "h264", mode: "motion" },
  ultra: { height: 0, fps: 60, bitrate: 25_000_000, codec: "h264", mode: "balanced" },
  extreme: { height: 0, fps: 60, bitrate: 40_000_000, codec: "h264", mode: "balanced" },
};

/** Settings saved before 1.7.5 used capture sizes as names. */
const LEGACY: Record<string, ScreenPresetId> = { "720p30": "low", "1080p30": "standard", "1080p60": "games", "1440p60": "gamesPlus", source: "ultra" };

export function normalizeScreenQuality(q: string | undefined): ScreenPresetId | "custom" {
  if (q === "custom") return "custom";
  if (q && (SCREEN_PRESET_IDS as readonly string[]).includes(q)) return q as ScreenPresetId;
  return LEGACY[q ?? ""] ?? "standard";
}

export const DEFAULT_SCREEN_CUSTOM: ScreenCustom = { height: 1080, fps: 60, bitrateKbps: 12_000, codec: "h264", mode: "balanced" };

/** What the chosen quality (and codec override) comes to. */
export function resolveScreenPreset(quality: string | undefined, custom: ScreenCustom | undefined, codec: "auto" | ScreenCodec | undefined): ScreenPreset {
  const id = normalizeScreenQuality(quality);
  const base: ScreenPreset =
    id === "custom"
      ? (() => {
          const c = { ...DEFAULT_SCREEN_CUSTOM, ...custom };
          return { height: c.height, fps: c.fps, bitrate: Math.round(Math.min(60_000, Math.max(300, c.bitrateKbps)) * 1000), codec: c.codec, mode: c.mode };
        })()
      : SCREEN_PRESETS[id];
  const chosen = id === "custom" ? base.codec : codec && codec !== "auto" ? codec : base.codec;
  return { ...base, codec: supportedCodecs().includes(chosen) ? chosen : "h264" };
}

let codecsCache: ScreenCodec[] | null = null;
/** Which of the codecs this app can send. */
export function supportedCodecs(): ScreenCodec[] {
  if (codecsCache) return codecsCache;
  const caps = typeof RTCRtpSender !== "undefined" && RTCRtpSender.getCapabilities ? RTCRtpSender.getCapabilities("video") : null;
  const have = new Set((caps?.codecs ?? []).map((c) => c.mimeType.toLowerCase()));
  codecsCache = (["h264", "vp9", "av1"] as const).filter((c) => have.has(`video/${c}`));
  if (!codecsCache.length) codecsCache = ["h264"];
  return codecsCache;
}

/**
 * Capture bounds for a preset: the screen is scaled down to fit them, keeping
 * its shape (the width bound leaves room for ultrawide screens). The screen's
 * own size is capped at 4K.
 */
export function captureSize(p: ScreenPreset): { width: number; height: number; frameRate: number } {
  if (!p.height) return { width: 3840, height: 2160, frameRate: p.fps };
  return { width: Math.round((p.height * 21) / 9), height: p.height, frameRate: p.fps };
}
