// UI sounds, synthesized with WebAudio (no audio files to ship). One family:
// soft sine/triangle tones with a faint detuned shimmer — "starlight".
import { settings } from "../store/settings";
import { getAsset } from "./assets";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

function ac(): AudioContext | null {
  try {
    if (!ctx) {
      ctx = new AudioContext({ latencyHint: "interactive" });
      master = ctx.createGain();
      master.connect(ctx.destination);
      applySink();
    }
    if (ctx.state === "suspended") void ctx.resume();
    master!.gain.value = Math.min(1.5, (settings().outputVolume ?? 100) / 100) * 0.9;
    return ctx;
  } catch {
    return null;
  }
}

/** Route UI sounds to the chosen output device where supported (Chromium). */
export function applySink() {
  const id = settings().outputDevice;
  const c = ctx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
  if (c?.setSinkId) void c.setSinkId(id && id !== "default" ? id : "").catch(() => {});
}

interface ToneOpts {
  type?: OscillatorType;
  gain?: number;
  attack?: number;
  glideTo?: number;
  shimmer?: boolean;
}

function tone(freq: number, at: number, dur: number, o: ToneOpts = {}) {
  const c = ac();
  if (!c || !master) return;
  const t0 = c.currentTime + at;
  const g = c.createGain();
  const peak = o.gain ?? 0.16;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + (o.attack ?? 0.008));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  g.connect(master);
  const voices = o.shimmer === false ? [0] : [0, 7];
  for (const cents of voices) {
    const osc = c.createOscillator();
    osc.type = o.type ?? "sine";
    osc.frequency.setValueAtTime(freq, t0);
    if (o.glideTo) osc.frequency.exponentialRampToValueAtTime(o.glideTo, t0 + dur * 0.8);
    osc.detune.value = cents;
    const vg = c.createGain();
    vg.gain.value = cents ? 0.35 : 1;
    osc.connect(vg).connect(g);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }
}

const N = { C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, A5: 880, B5: 987.77, C6: 1046.5, E6: 1318.5, G6: 1568, A6: 1760 };

const SOUNDS = {
  message: () => {
    tone(N.A5, 0, 0.18, { type: "triangle", gain: 0.1 });
    tone(N.E6, 0.07, 0.26, { type: "sine", gain: 0.09 });
  },
  mention: () => {
    tone(N.B5, 0, 0.14, { type: "triangle", gain: 0.12 });
    tone(N.E6, 0.08, 0.16, { gain: 0.11 });
    tone(N.G6, 0.16, 0.34, { gain: 0.1 });
  },
  join: () => {
    tone(N.C5, 0, 0.16, { type: "triangle", gain: 0.12 });
    tone(N.E5, 0.07, 0.16, { type: "triangle", gain: 0.12 });
    tone(N.G5, 0.14, 0.3, { gain: 0.12 });
  },
  leave: () => {
    tone(N.G5, 0, 0.16, { type: "triangle", gain: 0.11 });
    tone(N.E5, 0.08, 0.16, { type: "triangle", gain: 0.11 });
    tone(N.C5, 0.16, 0.3, { gain: 0.1 });
  },
  connect: () => {
    tone(N.E5, 0, 0.12, { type: "triangle", gain: 0.12 });
    tone(N.A5, 0.07, 0.12, { type: "triangle", gain: 0.12 });
    tone(N.C6, 0.14, 0.12, { gain: 0.11 });
    tone(N.E6, 0.21, 0.42, { gain: 0.1 });
  },
  disconnect: () => {
    tone(N.C6, 0, 0.14, { type: "triangle", gain: 0.11 });
    tone(N.G5, 0.09, 0.14, { type: "triangle", gain: 0.11 });
    tone(N.C5, 0.18, 0.34, { gain: 0.1, glideTo: 480 });
  },
  mute: () => tone(620, 0, 0.12, { type: "triangle", gain: 0.1, glideTo: 380, shimmer: false }),
  unmute: () => tone(380, 0, 0.12, { type: "triangle", gain: 0.1, glideTo: 640, shimmer: false }),
  deafen: () => {
    tone(520, 0, 0.1, { type: "triangle", gain: 0.1, shimmer: false });
    tone(340, 0.07, 0.16, { type: "triangle", gain: 0.1, shimmer: false });
  },
  undeafen: () => {
    tone(340, 0, 0.1, { type: "triangle", gain: 0.1, shimmer: false });
    tone(520, 0.07, 0.16, { type: "triangle", gain: 0.1, shimmer: false });
  },
  streamStart: () => {
    tone(N.G5, 0, 0.1, { gain: 0.1 });
    tone(N.B5, 0.06, 0.1, { gain: 0.1 });
    tone(N.E6, 0.12, 0.3, { gain: 0.09 });
  },
  streamStop: () => {
    tone(N.E6, 0, 0.1, { gain: 0.09 });
    tone(N.B5, 0.06, 0.1, { gain: 0.09 });
    tone(N.G5, 0.12, 0.26, { gain: 0.09 });
  },
  friend: () => {
    tone(N.D5, 0, 0.12, { type: "triangle", gain: 0.1 });
    tone(N.A5, 0.1, 0.3, { gain: 0.1 });
  },
  error: () => tone(220, 0, 0.22, { type: "sawtooth", gain: 0.05, glideTo: 160, shimmer: false }),
};

export type SoundName = keyof typeof SOUNDS;

export function playSound(name: SoundName, force = false) {
  if (!force && !settings().sounds) return;
  try {
    SOUNDS[name]();
  } catch {
    /* audio unavailable */
  }
}

// ── ringtones ────────────────────────────────────────────────────────────────
// Incoming-call melodies: one cycle each, repeated every `every` ms.
const seq = (notes: number[], step: number, dur: number, o: ToneOpts, at = 0) => notes.forEach((f, i) => f && tone(f, at + i * step, dur, o));

const RING: Record<string, { every: number; play: () => void }> = {
  // The signature: two bright rising figures.
  nova: {
    every: 2200,
    play: () => {
      seq([N.E6, N.G6, N.A6, N.G6], 0.11, 0.2, { type: "triangle", gain: 0.12 });
      seq([N.E6, N.G6, N.A6, N.G6], 0.11, 0.2, { type: "triangle", gain: 0.12 }, 0.6);
    },
  },
  // A desk phone: two trilled bursts.
  classic: {
    every: 3000,
    play: () => {
      for (const burst of [0, 0.55]) for (let i = 0; i < 8; i++) tone(i % 2 ? 480 : 440, burst + i * 0.05, 0.07, { type: "square", gain: 0.05, shimmer: false });
    },
  },
  // Slow bells falling.
  chime: {
    every: 3200,
    play: () => seq([N.C6, N.G5, N.E5, N.C5], 0.32, 1.1, { gain: 0.11, attack: 0.004 }),
  },
  // A modern two-note pulse.
  pulse: {
    every: 2000,
    play: () => {
      seq([N.A5, N.A5, 0, N.E6], 0.16, 0.14, { type: "sine", gain: 0.14, shimmer: false });
      seq([N.A5, N.A5, 0, N.E6], 0.16, 0.14, { type: "sine", gain: 0.14, shimmer: false }, 0.8);
    },
  },
  // 8-bit arcade.
  retro: {
    every: 1800,
    play: () => seq([N.C5, N.E5, N.G5, N.C6, N.G5, N.E5, N.C5, N.E5, N.G5, N.C6], 0.085, 0.09, { type: "square", gain: 0.045, shimmer: false }),
  },
  // Wooden and warm.
  marimba: {
    every: 2600,
    play: () => seq([N.E5, N.G5, N.B5, N.E6, N.B5, N.G5, N.E5, 0, N.G5, N.B5], 0.13, 0.32, { type: "triangle", gain: 0.13, attack: 0.003 }),
  },
};

export const RINGTONES = Object.keys(RING);
const MAX_CUSTOM_SECONDS = 30;

/** The user's own file, decoded once (until another one is chosen). */
let custom: AudioBuffer | null = null;
async function customBuffer(): Promise<AudioBuffer | null> {
  if (custom) return custom;
  const c = ac();
  const blob = await getAsset("ringtone");
  if (!c || !blob) return null;
  try {
    return (custom = await c.decodeAudioData(await blob.arrayBuffer()));
  } catch {
    return null;
  }
}
/** A new file was chosen or the old one removed: forget the decoded one. */
export const resetCustomRingtone = () => (custom = null);

/** Rings the chosen melody until stopped (`once`: a single cycle, for the preview). */
export function playRingtone(id: string = settings().ringtone, once = false): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let source: AudioBufferSourceNode | null = null;
  const melody = () => {
    const r = RING[id] ?? RING.nova;
    r.play();
    if (!once) timer = setInterval(() => !stopped && r.play(), r.every);
  };
  if (id === "custom") {
    void customBuffer().then((buffer) => {
      const c = ac();
      if (stopped) return;
      if (!buffer || !c || !master) return melody(); // the file is gone or unreadable
      source = c.createBufferSource();
      source.buffer = buffer;
      source.loop = !once;
      source.connect(master);
      source.start(0, 0, once ? Math.min(buffer.duration, 8) : undefined);
    });
  } else melody();
  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
    try {
      source?.stop();
    } catch {
      /* not started */
    }
  };
}

/** Checks that a picked file is audio the browser can play, and not an album. */
export async function validateRingtone(file: Blob): Promise<"ok" | "unreadable" | "too_long"> {
  const c = ac();
  if (!c) return "unreadable";
  try {
    const b = await c.decodeAudioData(await file.arrayBuffer());
    return b.duration > MAX_CUSTOM_SECONDS ? "too_long" : "ok";
  } catch {
    return "unreadable";
  }
}

/** Looping patterns for calls. Returns a stop function. */
export function loopSound(kind: "ring" | "ringback"): () => void {
  if (kind === "ring") return playRingtone();
  let stopped = false;
  const play = () => {
    if (stopped) return;
    tone(N.D5, 0, 1.0, { gain: 0.06, attack: 0.05 });
    tone(N.A5, 0, 1.0, { gain: 0.04, attack: 0.05 });
  };
  play();
  const id = setInterval(play, 3000);
  return () => {
    stopped = true;
    clearInterval(id);
  };
}
