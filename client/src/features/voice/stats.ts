// Live call diagnostics. Once a second while in voice, the WebRTC stats of our
// tracks become one sample (ping, packet loss, jitter, bitrate). The last minute
// is kept, so the connection panel opens with a history instead of an empty chart.
import { create } from "zustand";
import type { Track } from "livekit-client";
import { getRoom, useVoice } from "./voice";

export interface CallSample {
  /** epoch ms */
  at: number;
  /** Round trip to the voice server, ms. */
  ping: number | null;
  /** Packets lost in the last second, %, the worse of both directions. */
  loss: number | null;
  /** ms */
  jitter: number | null;
  upKbps: number | null;
  downKbps: number | null;
}

export interface CallRoute {
  /** direct (host candidate), nat (server-reflexive), relay (TURN) */
  type: "direct" | "nat" | "relay" | null;
  protocol: string | null;
  codec: string | null;
  codecKhz: number | null;
}

export const WINDOW_MS = 60_000;

export const useCallStats = create<{ samples: CallSample[]; route: CallRoute }>(() => ({
  samples: [],
  route: { type: null, protocol: null, codec: null, codecKhz: null },
}));

type Stat = { id: string; type: string; [k: string]: unknown };
type Stats = Map<string, Stat>;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** One peer connection's stats, merged from the reports of the tracks on it. */
async function collect(tracks: Track[]): Promise<Stats> {
  const out: Stats = new Map();
  const reports = await Promise.all(tracks.map((t) => t.getRTCStatsReport().catch(() => undefined)));
  for (const r of reports) r?.forEach((s: Stat) => out.set(s.id, s));
  return out;
}

function selectedPair(m: Stats): Stat | undefined {
  for (const s of m.values()) if (s.type === "transport" && typeof s.selectedCandidatePairId === "string") return m.get(s.selectedCandidatePairId);
  for (const s of m.values()) if (s.type === "candidate-pair" && s.state === "succeeded" && s.nominated) return s;
  return undefined;
}

interface Counters {
  at: number;
  bytesOut: number;
  bytesIn: number;
  sentOut: number;
  lostOut: number;
  recvIn: number;
  lostIn: number;
}

let prev: Counters | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

async function tick() {
  const room = getRoom();
  if (!room || busy) return;
  busy = true;
  try {
    const local = [...room.localParticipant.trackPublications.values()].flatMap((p) => (p.track ? [p.track as Track] : []));
    const remote = [...room.remoteParticipants.values()].flatMap((rp) => [...rp.trackPublications.values()].flatMap((p) => (p.track ? [p.track as Track] : [])));
    const [pub, sub] = await Promise.all([collect(local), collect(remote)]);

    const c: Counters = { at: Date.now(), bytesOut: 0, bytesIn: 0, sentOut: 0, lostOut: 0, recvIn: 0, lostIn: 0 };
    const jitters: number[] = [];
    let codec: string | null = null;
    let codecKhz: number | null = null;
    for (const s of pub.values()) {
      if (s.type === "outbound-rtp") {
        c.bytesOut += num(s.bytesSent) ?? 0;
        if (s.kind === "audio") {
          c.sentOut += num(s.packetsSent) ?? 0;
          const cs = typeof s.codecId === "string" ? pub.get(s.codecId) : undefined;
          if (cs && typeof cs.mimeType === "string") {
            const name = cs.mimeType.replace(/^audio\//i, "");
            codec = name.charAt(0).toUpperCase() + name.slice(1);
            codecKhz = num(cs.clockRate) ? Math.round(num(cs.clockRate)! / 1000) : null;
          }
        }
      } else if (s.type === "remote-inbound-rtp" && s.kind === "audio") {
        c.lostOut += Math.max(0, num(s.packetsLost) ?? 0);
        if (num(s.jitter) != null) jitters.push(num(s.jitter)! * 1000);
      }
    }
    for (const s of sub.values()) {
      if (s.type !== "inbound-rtp") continue;
      c.bytesIn += num(s.bytesReceived) ?? 0;
      if (s.kind === "audio") {
        c.recvIn += num(s.packetsReceived) ?? 0;
        c.lostIn += Math.max(0, num(s.packetsLost) ?? 0);
        if (num(s.jitter) != null) jitters.push(num(s.jitter)! * 1000);
      }
    }

    // Ping: the ICE round trip of the connection in use (measured even while muted).
    const m = selectedPair(pub) ? pub : sub;
    const pair = selectedPair(m);
    const rtt = num(pair?.currentRoundTripTime);
    const cand = pair && typeof pair.localCandidateId === "string" ? m.get(pair.localCandidateId) : undefined;
    const kind = cand?.candidateType;
    const route: CallRoute = {
      type: kind === "host" ? "direct" : kind === "relay" ? "relay" : kind === "srflx" || kind === "prflx" ? "nat" : null,
      protocol: typeof (kind === "relay" ? cand?.relayProtocol : cand?.protocol) === "string" ? String(kind === "relay" ? cand!.relayProtocol : cand!.protocol).toUpperCase() : null,
      codec,
      codecKhz,
    };

    const p = prev;
    const dt = p ? (c.at - p.at) / 1000 : 0;
    const rate = (now: number, before: number) => (p && dt > 0 && now >= before ? Math.round(((now - before) * 8) / 1000 / dt) : null);
    const pct = (lost: number, total: number) => (total > 0 ? Math.min(100, (lost / total) * 100) : null);
    const lossIn = p ? pct(c.lostIn - p.lostIn, c.lostIn - p.lostIn + (c.recvIn - p.recvIn)) : null;
    const lossOut = p ? pct(c.lostOut - p.lostOut, c.sentOut - p.sentOut) : null;
    const sample: CallSample = {
      at: c.at,
      ping: rtt != null ? Math.round(rtt * 1000) : null,
      loss: lossIn == null && lossOut == null ? null : Math.max(lossIn ?? 0, lossOut ?? 0),
      jitter: jitters.length ? Math.round(jitters.reduce((a, b) => a + b, 0) / jitters.length) : null,
      upKbps: rate(c.bytesOut, p?.bytesOut ?? 0),
      downKbps: rate(c.bytesIn, p?.bytesIn ?? 0),
    };
    prev = c;
    const keep = c.at - WINDOW_MS - 2000;
    useCallStats.setState((s) => ({ samples: [...s.samples.filter((x) => x.at > keep), sample], route }));
  } finally {
    busy = false;
  }
}

function start() {
  stop();
  useCallStats.setState({ samples: [], route: { type: null, protocol: null, codec: null, codecKhz: null } });
  timer = setInterval(() => void tick(), 1000);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  prev = null;
}

// Sample for as long as we're in a call: leaving or switching channels starts a
// new history, a reconnect in the same channel keeps it.
useVoice.subscribe((s, p) => {
  if (s.channelId !== p.channelId && timer) stop();
  if (s.state === "connected" && !timer) start();
});
if (useVoice.getState().state === "connected") start();

/** Latest ping in ms (null before the first measurement). */
export const usePing = () => useCallStats((s) => s.samples.at(-1)?.ping ?? null);
