// Soundboard: short sounds played into the call. A clip is mixed straight into
// the outgoing microphone track — past the denoiser, the gate and the voice
// effect — so everybody hears it as it is, even while the mic is muted, and
// every client version can play it. The built-in set is synthesized (nothing
// to ship or license); your own sounds and the ones shared with a server are
// kept on the server (expressions.ts), so they are on every device.
import { create } from "zustand";
import { MAX_SOUND_BYTES } from "@nova/shared";
import { toast } from "../../lib/bus";
import { t } from "../../lib/i18n";
import { decodeAudio, playBuffer } from "../../lib/sound";
import { mediaUrl } from "../../lib/server";
import { sendClip, sendClipStop, useVoice, type ClipMessage } from "./voice";
import { useExpressions } from "./expressions";

export const MAX_CLIP_SECONDS = 30;
/** As much as the server takes (MAX_SOUND_BYTES). */
export const MAX_CLIP_BYTES = MAX_SOUND_BYTES;

// ── built-in sounds ──────────────────────────────────────────────────────────
const RATE = 48_000;
type Ctx = OfflineAudioContext;

interface Voice {
  type?: OscillatorType;
  /** Peak level. */
  gain?: number;
  attack?: number;
  /** Seconds of release at the end (linear). */
  release?: number;
  /** Frequency reached at the end of the note. */
  glideTo?: number;
  detune?: number;
  /** Decays like a struck thing instead of being held. */
  pluck?: boolean;
  out?: AudioNode;
}

function osc(c: Ctx, freq: number, at: number, dur: number, v: Voice = {}): OscillatorNode {
  const o = c.createOscillator();
  o.type = v.type ?? "sine";
  o.frequency.setValueAtTime(freq, at);
  if (v.glideTo) o.frequency.exponentialRampToValueAtTime(v.glideTo, at + dur);
  if (v.detune) o.detune.value = v.detune;
  const g = c.createGain();
  const peak = v.gain ?? 0.3;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(peak, at + (v.attack ?? 0.008));
  if (v.pluck) g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  else {
    const rel = Math.min(v.release ?? 0.05, dur / 2);
    g.gain.setValueAtTime(peak, at + dur - rel);
    g.gain.linearRampToValueAtTime(0.0001, at + dur);
  }
  o.connect(g).connect(v.out ?? c.destination);
  o.start(at);
  o.stop(at + dur + 0.02);
  return o;
}

/** Deterministic noise: a built-in sounds the same every time. */
function noiseBuffer(c: Ctx, seconds: number, seed = 1): AudioBuffer {
  const b = c.createBuffer(1, Math.ceil(seconds * RATE), RATE);
  const d = b.getChannelData(0);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < d.length; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    d[i] = ((s >>> 0) / 0xffffffff) * 2 - 1;
  }
  return b;
}

function noise(c: Ctx, at: number, dur: number, o: { gain?: number; attack?: number; filter?: BiquadFilterType; freq?: number; freqTo?: number; q?: number; seed?: number; out?: AudioNode }) {
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, dur + 0.05, o.seed);
  const f = c.createBiquadFilter();
  f.type = o.filter ?? "bandpass";
  f.frequency.setValueAtTime(o.freq ?? 1500, at);
  if (o.freqTo) f.frequency.exponentialRampToValueAtTime(o.freqTo, at + dur);
  f.Q.value = o.q ?? 0.8;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(o.gain ?? 0.4, at + (o.attack ?? 0.004));
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  src.connect(f).connect(g).connect(o.out ?? c.destination);
  src.start(at);
  src.stop(at + dur + 0.02);
}

function lowpass(c: Ctx, freq: number, q = 0.7): BiquadFilterNode {
  const f = c.createBiquadFilter();
  f.type = "lowpass";
  f.frequency.value = freq;
  f.Q.value = q;
  f.connect(c.destination);
  return f;
}

interface Builtin {
  id: string;
  icon: string;
  seconds: number;
  /** Loudness relative to the others (1 when omitted). */
  trim?: number;
  draw: (c: Ctx) => void;
}

const BUILTIN: Builtin[] = [
  {
    // Two reedy notes a little apart — the stadium horn.
    id: "airhorn",
    icon: "📯",
    seconds: 1.25,
    draw(c) {
      const out = lowpass(c, 3200, 2);
      for (const [f, d] of [[466, -9], [466, 8], [587, -6], [587, 11], [233, 0]] as const) {
        const o = osc(c, f * 0.94, 0, 1.15, { type: "sawtooth", gain: 0.16, attack: 0.02, release: 0.12, detune: d, out });
        o.frequency.exponentialRampToValueAtTime(f, 0.07);
      }
    },
  },
  {
    // Ba-dum… tss.
    id: "rimshot",
    icon: "🥁",
    seconds: 1.5,
    draw(c) {
      osc(c, 190, 0, 0.2, { gain: 0.7, glideTo: 95, pluck: true, attack: 0.003 });
      osc(c, 150, 0.19, 0.22, { gain: 0.7, glideTo: 75, pluck: true, attack: 0.003 });
      osc(c, 220, 0.46, 0.12, { gain: 0.4, glideTo: 130, pluck: true, attack: 0.002 });
      noise(c, 0.46, 0.14, { gain: 0.5, freq: 1900, q: 0.6, seed: 7 });
      noise(c, 0.46, 1.0, { gain: 0.32, filter: "highpass", freq: 6500, q: 0.4, seed: 11 });
    },
  },
  {
    // A room of hands: one noise bed shaped by hundreds of tiny random claps.
    id: "applause",
    icon: "👏",
    seconds: 3,
    draw(c) {
      const seconds = 2.9;
      const src = c.createBufferSource();
      src.buffer = noiseBuffer(c, seconds, 23);
      const band = c.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.value = 1700;
      band.Q.value = 0.55;
      const g = c.createGain();
      const steps = Math.floor(seconds * 1000);
      const curve = new Float32Array(steps);
      let s = 99;
      const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff);
      for (let n = 0; n < 420; n++) {
        const at = Math.floor(rnd() * (steps - 40));
        const level = 0.25 + rnd() * 0.75;
        for (let k = 0; k < 28; k++) curve[at + k] += level * Math.exp(-k / 6);
      }
      for (let i = 0; i < steps; i++) {
        const x = i / steps;
        const swell = Math.min(1, x / 0.12) * Math.min(1, (1 - x) / 0.3);
        curve[i] = Math.min(1, curve[i] * 0.22) * swell;
      }
      g.gain.setValueCurveAtTime(curve, 0, seconds);
      src.connect(band).connect(g).connect(c.destination);
      src.start(0);
    },
  },
  {
    // Wah, wah, wah, waaah.
    id: "trombone",
    icon: "🎺",
    seconds: 2.5,
    draw(c) {
      const out = lowpass(c, 1100, 3);
      const notes: [number, number, number][] = [[233.1, 0, 0.36], [220, 0.4, 0.36], [207.7, 0.8, 0.36], [196, 1.2, 1.2]];
      for (const [f, at, dur] of notes) {
        const last = dur > 1;
        for (const d of [-6, 6]) {
          const o = osc(c, f, at, dur, { type: "sawtooth", gain: 0.26, attack: 0.04, release: last ? 0.5 : 0.08, detune: d, out });
          if (last) {
            o.frequency.setValueAtTime(f, at + 0.25);
            o.frequency.exponentialRampToValueAtTime(f * 0.89, at + dur);
          }
          const lfo = c.createOscillator();
          lfo.frequency.value = 5.5;
          const depth = c.createGain();
          depth.gain.value = last ? 5 : 2;
          lfo.connect(depth).connect(o.frequency);
          lfo.start(at);
          lfo.stop(at + dur);
        }
      }
    },
  },
  {
    // Right answer: two bright bell notes.
    id: "ding",
    icon: "✅",
    seconds: 1.1,
    draw(c) {
      for (const [f, at] of [[1046.5, 0], [1568, 0.13]] as const) {
        osc(c, f, at, 0.85, { gain: 0.4, pluck: true });
        osc(c, f * 2.01, at, 0.4, { gain: 0.1, pluck: true });
        osc(c, f * 3.02, at, 0.2, { gain: 0.05, pluck: true });
      }
    },
  },
  {
    // Wrong answer.
    id: "buzzer",
    icon: "❌",
    seconds: 0.8,
    trim: 0.8,
    draw(c) {
      const out = lowpass(c, 1400, 1);
      for (const f of [116, 123, 232]) osc(c, f, 0, 0.7, { type: "square", gain: 0.22, attack: 0.005, release: 0.04, out });
    },
  },
  {
    // Pew-pew.
    id: "laser",
    icon: "🔫",
    seconds: 0.75,
    draw(c) {
      for (const at of [0, 0.2, 0.4]) {
        osc(c, 2400, at, 0.26, { type: "sawtooth", gain: 0.28, glideTo: 180, pluck: true, attack: 0.002 });
        osc(c, 1200, at, 0.26, { type: "square", gain: 0.12, glideTo: 90, pluck: true, attack: 0.002 });
      }
    },
  },
  {
    // A spring let go.
    id: "boing",
    icon: "🐸",
    seconds: 1.1,
    draw(c) {
      const o = osc(c, 170, 0, 1, { type: "triangle", gain: 0.6, pluck: true, attack: 0.004 });
      const lfo = c.createOscillator();
      lfo.frequency.setValueAtTime(11, 0);
      lfo.frequency.linearRampToValueAtTime(24, 1);
      const depth = c.createGain();
      depth.gain.setValueAtTime(110, 0);
      depth.gain.exponentialRampToValueAtTime(4, 1);
      lfo.connect(depth).connect(o.frequency);
      lfo.start(0);
      lfo.stop(1.02);
    },
  },
  {
    // An awkward silence.
    id: "crickets",
    icon: "🦗",
    seconds: 2.8,
    trim: 0.45,
    draw(c) {
      for (let chirp = 0; chirp < 5; chirp++) {
        for (let pulse = 0; pulse < 4; pulse++) {
          const at = 0.1 + chirp * 0.55 + pulse * 0.045;
          osc(c, 4300 + (chirp % 2) * 120, at, 0.03, { gain: 0.22, attack: 0.004, release: 0.012 });
          osc(c, 8600, at, 0.03, { gain: 0.04, attack: 0.004, release: 0.012 });
        }
      }
    },
  },
  {
    // Ta-daa!
    id: "tada",
    icon: "🎉",
    seconds: 1.7,
    draw(c) {
      const out = lowpass(c, 2600, 1);
      for (const f of [392, 523.25]) osc(c, f, 0, 0.13, { type: "sawtooth", gain: 0.14, attack: 0.01, release: 0.03, out });
      for (const f of [523.25, 659.25, 783.99, 1046.5]) {
        osc(c, f, 0.17, 1.4, { type: "sawtooth", gain: 0.11, attack: 0.015, release: 0.9, out });
        osc(c, f, 0.17, 1.4, { type: "triangle", gain: 0.1, attack: 0.015, release: 0.9 });
      }
    },
  },
  {
    id: "siren",
    icon: "🚨",
    seconds: 2.5,
    trim: 0.7,
    draw(c) {
      const out = lowpass(c, 2800, 1);
      for (const type of ["sawtooth", "sine"] as const) {
        const o = osc(c, 650, 0, 2.4, { type, gain: type === "sine" ? 0.28 : 0.14, attack: 0.03, release: 0.15, out });
        for (let i = 0; i < 4; i++) {
          o.frequency.exponentialRampToValueAtTime(1080, i * 0.6 + 0.3);
          o.frequency.exponentialRampToValueAtTime(650, i * 0.6 + 0.6);
        }
      }
    },
  },
  {
    id: "boom",
    icon: "💥",
    seconds: 1.8,
    draw(c) {
      noise(c, 0, 1.6, { gain: 0.9, filter: "lowpass", freq: 2400, freqTo: 90, q: 0.9, seed: 31 });
      noise(c, 0, 0.12, { gain: 0.5, filter: "highpass", freq: 3000, q: 0.5, seed: 37 });
      osc(c, 78, 0, 1.1, { gain: 0.9, glideTo: 32, pluck: true, attack: 0.004 });
    },
  },
];

export const BUILTIN_CLIPS = BUILTIN.map((b) => ({ id: b.id, icon: b.icon }));

const PEAK = 0.9;
const LOUD_RMS = 0.2;

/**
 * Evens out loudness: the loud part of every sound (its 90th-percentile 50 ms
 * window — so pauses and long tails don't count) lands on the same level, and
 * nothing clips. A steady siren and a single drum hit end up comparable, and
 * somebody's over-compressed MP3 doesn't blast the call. `trim` is a
 * per-sound correction on top.
 */
export function normalise(b: AudioBuffer, trim = 1): AudioBuffer {
  const win = Math.max(1, Math.round(b.sampleRate * 0.05));
  const levels: number[] = [];
  let peak = 0;
  const first = b.getChannelData(0);
  for (let at = 0; at < first.length; at += win) {
    let sum = 0;
    let n = 0;
    for (let ch = 0; ch < b.numberOfChannels; ch++) {
      const d = b.getChannelData(ch);
      const end = Math.min(d.length, at + win);
      for (let i = at; i < end; i++) {
        const v = d[i];
        sum += v * v;
        n++;
        if (v > peak) peak = v;
        else if (-v > peak) peak = -v;
      }
    }
    levels.push(Math.sqrt(sum / Math.max(1, n)));
  }
  if (peak < 0.0001) return b;
  levels.sort((x, y) => x - y);
  const loud = levels[Math.min(levels.length - 1, Math.floor(levels.length * 0.9))] || peak;
  const k = Math.min(PEAK / peak, (LOUD_RMS * trim) / loud);
  for (let ch = 0; ch < b.numberOfChannels; ch++) {
    const d = b.getChannelData(ch);
    for (let i = 0; i < d.length; i++) d[i] *= k;
  }
  return b;
}

export async function renderBuiltin(id: string): Promise<AudioBuffer | null> {
  const b = BUILTIN.find((x) => x.id === id);
  if (!b) return null;
  const c = new OfflineAudioContext(1, Math.ceil(b.seconds * RATE), RATE);
  b.draw(c);
  return normalise(await c.startRendering(), b.trim);
}

// ── your own and the servers’ sounds (kept on the server) ──────────────────
const VOLUME_KEY = "nova.soundboard.volume";

function readVolume(): number {
  try {
    const n = Number(localStorage.getItem(VOLUME_KEY) ?? "70");
    return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 70;
  } catch {
    return 70;
  }
}

interface SoundboardState {
  /** How many copies of each clip are sounding right now. */
  playing: Record<string, number>;
  /** 0–100, for what goes into the call and what you hear yourself. */
  volume: number;
  /** Sounds others in the call are playing here right now, by who. */
  heard: Record<string, number>;
  /** The last of them, with the volume it got. */
  lastHeard: { from: string; id: string; gain: number } | null;
}

export const useSoundboard = create<SoundboardState>(() => ({ playing: {}, volume: readVolume(), heard: {}, lastHeard: null }));

export function setSoundboardVolume(volume: number) {
  useSoundboard.setState({ volume });
  try {
    localStorage.setItem(VOLUME_KEY, String(Math.round(volume)));
  } catch {
    /* not essential */
  }
}

/** Is this file a sound we can play, and short enough? */
export async function checkClip(file: Blob): Promise<"ok" | "unreadable" | "too_long" | "too_big"> {
  if (file.size > MAX_CLIP_BYTES) return "too_big";
  const b = await decodeAudio(file);
  if (!b) return "unreadable";
  return b.duration > MAX_CLIP_SECONDS ? "too_long" : "ok";
}

const isBuiltin = (id: string) => BUILTIN.some((b) => b.id === id);

/** Decoded clips: built-ins by id, server sounds by file (a replaced file is fetched again). The oldest go first past a limit. */
const buffers = new Map<string, Promise<AudioBuffer | null>>();
const MAX_BUFFERS = 48;

/** A built-in (`url` null) or a server file, decoded and levelled. */
function loadBuffer(id: string, url: string | null): Promise<AudioBuffer | null> {
  const key = url ?? id;
  const hit = buffers.get(key);
  if (hit) {
    buffers.delete(key);
    buffers.set(key, hit);
    return hit;
  }
  const p = (
    url
      ? fetch(mediaUrl(url)!)
          .then((r) => (r.ok ? r.blob() : null))
          .then((blob) => (blob ? decodeAudio(blob) : null))
          .then((b) => (b ? normalise(b) : null))
      : renderBuiltin(id)
  ).catch(() => null);
  buffers.set(key, p);
  if (buffers.size > MAX_BUFFERS) buffers.delete(buffers.keys().next().value!);
  // A failure isn’t remembered: the next click tries again.
  void p.then((b) => !b && buffers.get(key) === p && buffers.delete(key));
  return p;
}

/** The file of a sound of yours or a server's; null for a built-in (and for a sound that's gone: undefined). */
function soundUrl(id: string): string | null | undefined {
  if (isBuiltin(id)) return null;
  return useExpressions.getState().sounds.find((x) => x.id === id)?.url;
}

// ── playing ──────────────────────────────────────────────────────────────────
const MAX_AT_ONCE = 4;
const stops = new Set<() => void>();

const bumpPlaying = (id: string, by: number) =>
  useSoundboard.setState((s) => {
    const n = Math.max(0, (s.playing[id] ?? 0) + by);
    const playing = { ...s.playing };
    if (n) playing[id] = n;
    else delete playing[id];
    return { playing };
  });

/** Own share of the sound in one's headphones, relative to what the call gets. */
const MONITOR = 0.7;

// Numbers each playing, so a stop reaches the right one (random start: a restart doesn't reuse them).
let playNo = Math.floor(Math.random() * 1e9);

/**
 * Plays a clip: in the call when there is one (everybody plays it on their
 * side), and to yourself either way. `localOnly` is the preview in settings
 * and the editor.
 */
export async function playClip(id: string, localOnly = false) {
  const v = useVoice.getState();
  const inCall = !localOnly && v.state === "connected";
  if (inCall && v.deafened) return toast(t("soundboard.deafened"));
  if (stops.size >= MAX_AT_ONCE) return;
  const url = soundUrl(id);
  const buffer = url === undefined ? null : await loadBuffer(id, url);
  if (!buffer || url === undefined) return toast(t("soundboard.unreadable"), "error");
  const gain = useSoundboard.getState().volume / 100;
  const n = ++playNo;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    stops.delete(stop);
    bumpPlaying(id, -1);
  };
  const sent = inCall && sendClip({ id, url, g: gain, n });
  const local = playBuffer(buffer, gain * (sent ? MONITOR : 1), finish);
  // If the audio engine never says it ended (paused while the app was busy or hidden), it still frees its place.
  setTimeout(finish, buffer.duration * 1000 + 500);
  const stop = () => {
    if (sent) sendClipStop(n);
    local();
    finish();
  };
  stops.add(stop);
  bumpPlaying(id, 1);
  if (inCall && !sent) toast(t("soundboard.notAllowed"));
}

export function stopClips() {
  for (const stop of [...stops]) stop();
}

// ── others' sounds, played here ──────────────────────────────────────────────
/** Only this server's own files: a sound must not make everyone fetch an address of the sender's choosing. */
const SAFE_URL = /^\/files\/[\w\-./%]+$/;
/** All at once, from everyone together. */
const MAX_HEARD = 8;
/** A slow first download doesn't lose the sound: it plays from where the sender is by now (under this, from the start). */
const LATE_OK_MS = 400;

const heard = new Map<string, { from: string; stop: () => void }>();

/** Gets this server's sounds (and your own) ready, so the first time someone plays one it isn't late. */
export function prefetchSounds(guildId: string | null) {
  const wanted = useExpressions.getState().sounds.filter((s) => s.guildId === guildId || s.guildId === null).slice(0, 24);
  let i = 0;
  const next = () => {
    const s = wanted[i++];
    if (s) void loadBuffer(s.id, s.url).finally(next);
  };
  next();
}

/** Someone in the call played a sound; `gain` is how loud you set them (their soundboard, and everyone's). */
export function playRemoteClip(from: string, msg: ClipMessage, gain: number) {
  const url = typeof msg.url === "string" && SAFE_URL.test(msg.url) && !msg.url.includes("..") ? msg.url : null;
  if (typeof msg.id !== "string" || typeof msg.n !== "number" || (!url && (msg.url != null || !isBuiltin(msg.id)))) return;
  const key = `${from}:${msg.n}`;
  if (heard.has(key) || heard.size >= MAX_HEARD) return;
  if ([...heard.values()].filter((h) => h.from === from).length >= MAX_AT_ONCE) return;
  const at = Date.now();
  let stopped = false;
  let stopLocal: (() => void) | null = null;
  const done = () => {
    if (heard.get(key)?.stop !== stop) return;
    heard.delete(key);
    bumpHeard(from, -1);
  };
  const stop = () => {
    stopped = true;
    stopLocal?.();
    done();
  };
  heard.set(key, { from, stop });
  bumpHeard(from, 1);
  void loadBuffer(msg.id, url).then((b) => {
    if (stopped) return;
    const late = Date.now() - at;
    const offset = late > LATE_OK_MS ? late / 1000 : 0;
    if (!b || offset >= b.duration - 0.15) return done();
    const g = Math.min(1, Math.max(0, Number(msg.g) || 0)) * gain;
    useSoundboard.setState({ lastHeard: { from, id: msg.id, gain: g } });
    stopLocal = playBuffer(b, g, done, offset);
    setTimeout(done, (b.duration - offset) * 1000 + 500);
  });
}

/** Stops one sound someone played (or theirs, or everyone's). */
export function stopRemoteClips(from?: string, n?: number) {
  for (const [key, h] of [...heard]) if ((from == null || h.from === from) && (n == null || key === `${from}:${n}`)) h.stop();
}

const bumpHeard = (from: string, by: number) =>
  useSoundboard.setState((s) => {
    const k = Math.max(0, (s.heard[from] ?? 0) + by);
    const next = { ...s.heard };
    if (k) next[from] = k;
    else delete next[from];
    return { heard: next };
  });
