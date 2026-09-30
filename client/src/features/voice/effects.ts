// Voice changer: effects for the outgoing microphone, built from plain Web
// Audio nodes (no extra worklets), so they cost almost nothing and can be
// swapped while talking. Each effect is a small graph between `input` and
// `output`; "none" is a straight wire.

export const VOICE_EFFECTS = ["none", "high", "low", "robot", "radio", "echo", "cave", "alien", "demon", "underwater"] as const;
export type VoiceEffect = (typeof VOICE_EFFECTS)[number];

export interface EffectGraph {
  input: AudioNode;
  output: AudioNode;
  dispose(): void;
}

type Ctx = BaseAudioContext;

/** Collects everything an effect creates so dispose() can stop and unplug it. */
class Parts {
  private nodes: AudioNode[] = [];
  private sources: AudioScheduledSourceNode[] = [];
  add<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }
  start<T extends AudioScheduledSourceNode>(n: T, when = 0): T {
    this.nodes.push(n);
    this.sources.push(n);
    n.start(when);
    return n;
  }
  dispose() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* never started */
      }
    }
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* already gone */
      }
    }
  }
}

// ── pitch shift ──────────────────────────────────────────────────────────────
// The classic two-head delay-line shifter: each head's delay time sweeps as a
// sawtooth (which changes playback speed, hence pitch) and the two heads
// cross-fade so the jump at the end of each sweep is never heard.
const SWEEP = 0.1; // seconds per head
const FADE = 0.05;

function sweepBuffer(ctx: Ctx, up: boolean): AudioBuffer {
  const active = Math.round(SWEEP * ctx.sampleRate);
  const rest = Math.round((SWEEP - 2 * FADE) * ctx.sampleRate);
  const buf = ctx.createBuffer(1, active + rest, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < active; i++) d[i] = up ? (active - i) / active : i / active;
  return buf;
}

function fadeBuffer(ctx: Ctx): AudioBuffer {
  const active = Math.round(SWEEP * ctx.sampleRate);
  const rest = Math.round((SWEEP - 2 * FADE) * ctx.sampleRate);
  const fade = Math.round(FADE * ctx.sampleRate);
  const buf = ctx.createBuffer(1, active + rest, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < active; i++) d[i] = i < fade ? Math.sqrt(i / fade) : i >= active - fade ? Math.sqrt((active - i) / fade) : 1;
  return buf;
}

/** `ratio` > 1 raises the voice, < 1 lowers it (0.5 … 2). */
function pitch(ctx: Ctx, parts: Parts, ratio: number): { input: AudioNode; output: AudioNode } {
  const input = parts.add(ctx.createGain());
  const output = parts.add(ctx.createGain());
  const depth = Math.abs(ratio - 1) * SWEEP; // delay swept per head, seconds
  const sweep = sweepBuffer(ctx, ratio > 1);
  const fade = fadeBuffer(ctx);
  const t0 = ctx.currentTime + 0.05;
  for (const offset of [0, SWEEP - FADE]) {
    const delay = parts.add(ctx.createDelay(1));
    delay.delayTime.value = 0;
    const mod = ctx.createBufferSource();
    mod.buffer = sweep;
    mod.loop = true;
    const modDepth = parts.add(ctx.createGain());
    modDepth.gain.value = depth;
    mod.connect(modDepth).connect(delay.delayTime);
    const mix = parts.add(ctx.createGain());
    mix.gain.value = 0;
    const env = ctx.createBufferSource();
    env.buffer = fade;
    env.loop = true;
    env.connect(mix.gain);
    input.connect(delay).connect(mix).connect(output);
    parts.start(mod, t0 + offset);
    parts.start(env, t0 + offset);
  }
  return { input, output };
}

// ── building blocks ──────────────────────────────────────────────────────────
function filter(ctx: Ctx, parts: Parts, type: BiquadFilterType, freq: number, q = 0.7): BiquadFilterNode {
  const f = parts.add(ctx.createBiquadFilter());
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

function gain(ctx: Ctx, parts: Parts, value: number): GainNode {
  const g = parts.add(ctx.createGain());
  g.gain.value = value;
  return g;
}

/** Multiplies the voice by a sine: the metallic "robot" timbre. */
function ringMod(ctx: Ctx, parts: Parts, hz: number): GainNode {
  const g = gain(ctx, parts, 0);
  const osc = ctx.createOscillator();
  osc.frequency.value = hz;
  osc.connect(g.gain);
  parts.start(osc);
  return g;
}

function distortion(ctx: Ctx, parts: Parts, amount: number): WaveShaperNode {
  const ws = parts.add(ctx.createWaveShaper());
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = ((1 + amount) * x) / (1 + amount * Math.abs(x));
  }
  ws.curve = curve;
  ws.oversample = "2x";
  return ws;
}

/** Decaying noise as an impulse response: a room without downloading one. */
function reverb(ctx: Ctx, parts: Parts, seconds: number, damping: number): ConvolverNode {
  const len = Math.round(seconds * ctx.sampleRate);
  const ir = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = ir.getChannelData(0);
  let lp = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    lp += (white - lp) * damping; // darker tail
    d[i] = lp * Math.pow(1 - i / len, 2.6);
  }
  const c = parts.add(ctx.createConvolver());
  c.normalize = true;
  c.buffer = ir;
  return c;
}

/** Dry signal plus a wet branch. */
function blend(ctx: Ctx, parts: Parts, from: AudioNode, wetChain: AudioNode[], dry: number, wet: number): GainNode {
  const out = parts.add(ctx.createGain());
  from.connect(gain(ctx, parts, dry)).connect(out);
  let n: AudioNode = from;
  for (const w of wetChain) n = n.connect(w);
  n.connect(gain(ctx, parts, wet)).connect(out);
  return out;
}

// ── the effects ──────────────────────────────────────────────────────────────
export function buildEffect(ctx: Ctx, effect: VoiceEffect): EffectGraph {
  const parts = new Parts();
  const input = parts.add(ctx.createGain());
  let out: AudioNode = input;
  switch (effect) {
    case "high": {
      const p = pitch(ctx, parts, 1.45);
      input.connect(p.input);
      out = p.output;
      break;
    }
    case "low": {
      const p = pitch(ctx, parts, 0.74);
      input.connect(p.input);
      out = p.output.connect(gain(ctx, parts, 1.25));
      break;
    }
    case "robot": {
      // Ring modulation + a short comb for the "tin can" resonance.
      const ring = ringMod(ctx, parts, 55);
      input.connect(ring);
      const comb = parts.add(ctx.createDelay(0.1));
      comb.delayTime.value = 0.012;
      const fb = gain(ctx, parts, 0.55);
      ring.connect(comb).connect(fb).connect(comb);
      const mix = gain(ctx, parts, 1.6);
      ring.connect(mix);
      comb.connect(mix);
      out = mix.connect(filter(ctx, parts, "highpass", 120));
      break;
    }
    case "radio": {
      // A walkie-talkie: narrow band, overdriven.
      out = input
        .connect(filter(ctx, parts, "highpass", 520, 0.9))
        .connect(filter(ctx, parts, "lowpass", 2600, 0.9))
        .connect(distortion(ctx, parts, 18))
        .connect(filter(ctx, parts, "peaking", 1600, 1.2))
        .connect(gain(ctx, parts, 0.75));
      break;
    }
    case "echo": {
      const delay = parts.add(ctx.createDelay(1));
      delay.delayTime.value = 0.26;
      const fb = gain(ctx, parts, 0.38);
      delay.connect(fb).connect(delay);
      out = blend(ctx, parts, input, [delay], 1, 0.55);
      break;
    }
    case "cave": {
      out = blend(ctx, parts, input, [reverb(ctx, parts, 2.8, 0.35)], 0.75, 1.1);
      break;
    }
    case "alien": {
      const p = pitch(ctx, parts, 1.22);
      input.connect(p.input);
      const ring = ringMod(ctx, parts, 140);
      p.output.connect(ring);
      const mix = gain(ctx, parts, 1);
      p.output.connect(gain(ctx, parts, 0.45)).connect(mix);
      ring.connect(gain(ctx, parts, 1.3)).connect(mix);
      out = mix;
      break;
    }
    case "demon": {
      const p = pitch(ctx, parts, 0.66);
      input.connect(p.input);
      const dirty = p.output.connect(distortion(ctx, parts, 6)).connect(filter(ctx, parts, "lowpass", 3200));
      out = blend(ctx, parts, dirty, [reverb(ctx, parts, 1.4, 0.2)], 1, 0.5);
      break;
    }
    case "underwater": {
      const lp = filter(ctx, parts, "lowpass", 620, 3);
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 1.7;
      lfo.connect(gain(ctx, parts, 220)).connect(lp.frequency);
      parts.start(lfo);
      out = input.connect(lp).connect(gain(ctx, parts, 1.5));
      break;
    }
    default:
      break;
  }
  return { input, output: out, dispose: () => parts.dispose() };
}
