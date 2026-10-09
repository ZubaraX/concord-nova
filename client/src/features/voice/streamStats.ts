// What a screen share really carries, from WebRTC's own statistics: size,
// frame rate, bitrate, codec — and, on the sending side, why the encoder is
// holding back ("bandwidth": the connection; "cpu": the computer). Shown on
// the stream on request, and written to the diagnostic log while streaming or
// watching, so a blurry stream can be told apart: a slow connection, a busy
// computer, or a low preset.
import { useEffect, useState } from "react";
import type { LocalVideoTrack, RemoteVideoTrack, Track } from "livekit-client";
import { diag } from "../../lib/diag";
import { getRoom, trackFor, useVoice } from "./voice";

export interface StreamStats {
  width: number;
  height: number;
  fps: number;
  /** Bits per second over the last interval. */
  bitrate: number;
  codec: string | null;
  /** Sending side: what limits the quality right now. */
  limit: "none" | "bandwidth" | "cpu" | "other" | null;
  /** Encoder or decoder in use (hardware ones say so). */
  impl: string | null;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

async function read(track: Track): Promise<{ stats: RTCStatsReport; outbound: boolean } | null> {
  const local = (track as LocalVideoTrack).sender;
  if (local) return { stats: await local.getStats(), outbound: true };
  const remote = (track as RemoteVideoTrack).receiver;
  if (remote) return { stats: await remote.getStats(), outbound: false };
  return null;
}

/** Totals for one moment; the bitrate comes from two of them. */
async function sample(track: Track) {
  const r = await read(track);
  if (!r) return null;
  let best: Record<string, unknown> | null = null;
  r.stats.forEach((s: Record<string, unknown>) => {
    if (s.type !== (r.outbound ? "outbound-rtp" : "inbound-rtp") || s.kind !== "video") return;
    // Several encodings (layers): the biggest is what viewers get.
    if (!best || num(s.frameWidth) > num(best.frameWidth)) best = s;
  });
  if (!best) return null;
  const s = best as Record<string, unknown>;
  const codec = typeof s.codecId === "string" ? (r.stats.get(s.codecId) as { mimeType?: string } | undefined)?.mimeType?.replace(/^video\//i, "") ?? null : null;
  const reason = r.outbound ? String(s.qualityLimitationReason ?? "") : "";
  return {
    at: performance.now(),
    bytes: num(r.outbound ? s.bytesSent : s.bytesReceived),
    width: num(s.frameWidth),
    height: num(s.frameHeight),
    fps: Math.round(num(s.framesPerSecond)),
    codec,
    limit: (r.outbound ? (["none", "bandwidth", "cpu"].includes(reason) ? reason : reason ? "other" : null) : null) as StreamStats["limit"],
    impl: (typeof (r.outbound ? s.encoderImplementation : s.decoderImplementation) === "string" ? String(r.outbound ? s.encoderImplementation : s.decoderImplementation) : null),
  };
}

/** Live statistics of someone's screen share (yours too), once a second while `on`. */
export function useStreamStats(userId: string, on: boolean): StreamStats | null {
  const [stats, setStats] = useState<StreamStats | null>(null);
  useEffect(() => {
    if (!on) return setStats(null);
    let prev: Awaited<ReturnType<typeof sample>> = null;
    let alive = true;
    const tick = async () => {
      const track = trackFor(userId, "screen");
      const s = track ? await sample(track).catch(() => null) : null;
      if (!alive) return;
      if (s && prev && s.at > prev.at) setStats({ ...s, bitrate: Math.max(0, ((s.bytes - prev.bytes) * 8 * 1000) / (s.at - prev.at)) });
      prev = s;
    };
    void tick();
    const id = setInterval(() => void tick(), 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [userId, on]);
  return stats;
}

// ── the diagnostic log: every 15 s while streaming or watching ───────────────
const last = new Map<string, Awaited<ReturnType<typeof sample>>>();

async function logStreams() {
  const room = getRoom();
  if (!room || useVoice.getState().state !== "connected") return last.clear();
  // Mine, and every share I'm receiving.
  const ids = [room.localParticipant.identity, ...room.remoteParticipants.keys()];
  for (const id of ids) {
    const track = trackFor(id, "screen");
    if (!track) {
      last.delete(id);
      continue;
    }
    const s = await sample(track).catch(() => null);
    const p = last.get(id);
    last.set(id, s);
    if (!s || !p || s.at <= p.at) continue;
    const mine = id === room.localParticipant.identity;
    const mbps = Math.round((((s.bytes - p.bytes) * 8) / (s.at - p.at) / 1000) * 10) / 10;
    diag("stream", mine ? "sending" : "watching", { who: mine ? undefined : id, size: `${s.width}x${s.height}`, fps: s.fps, mbps, codec: s.codec, limit: s.limit, impl: s.impl });
  }
}
setInterval(() => void logStreams(), 15_000);
