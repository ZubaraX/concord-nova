// Outgoing microphone chain, plugged into LiveKit as a track processor:
//
//   device → mono → rumble filter → [denoiser] → input gain → (analyser tap)
//          → gate → [voice effect] → published track
//
// The denoiser is DeepFilterNet3 ("deep": removes keyboards, fans, street and
// room noise, the closest open model to Krisp), RNNoise ("rnnoise": lighter,
// for weak devices) or nothing (the browser's own suppressor or off).
// The gate implements voice activation ("sensitivity") and push-to-talk by
// ramping gain — instant, glitch-free, and no track republish/renegotiation.
// The analyser sits before the gate, so we can still tell the user they're
// talking into a muted mic. The voice effect comes last, so echo and reverb
// tails ring out after the gate closes.
import type { Track } from "livekit-client";
import type { AudioProcessorOptions, TrackProcessor } from "livekit-client";
import { settings } from "../../store/settings";
import type { VoiceParams } from "@nova/shared";
import { buildEffect, type EffectGraph } from "./effects";

// DeepFilterNet3: the WASM runtime and the model ship with the app (public/df3),
// nothing is fetched from third-party servers.
type DeepCore = import("deepfilternet3-noise-filter").DeepFilterNet3Core;
let deepCore: Promise<DeepCore> | null = null;

// The model's runtime asks for random bytes (hash-map seeds, nothing secret),
// but an AudioWorklet has no `crypto` — without this it silently passes audio
// through unprocessed. Loaded into the worklet scope before the model.
let shimUrl: string | null = null;
const cryptoShimUrl = () =>
  (shimUrl ??= URL.createObjectURL(
    new Blob(
      ['if (typeof globalThis.crypto === "undefined") globalThis.crypto = { getRandomValues(a) { for (let i = 0; i < a.length; i++) a[i] = (Math.random() * 256) | 0; return a; } };'],
      { type: "application/javascript" }
    )
  ));

/** The model archive exactly as published (gzip). Some servers add Content-Encoding to it and the browser unpacks it on the way — pack it back. */
async function modelBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DeepFilterNet model: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const head = new Uint8Array(buf, 0, 2);
  if (head[0] === 0x1f && head[1] === 0x8b) return buf;
  return new Response(new Blob([buf]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
}

/** Downloads and compiles DeepFilterNet once per session (shared by every call). */
function loadDeepCore(): Promise<DeepCore> {
  deepCore ??= (async () => {
    const { DeepFilterNet3Core } = await import("deepfilternet3-noise-filter");
    // 100 dB attenuation limit = remove the noise completely.
    const core = new DeepFilterNet3Core({ sampleRate: 48_000, noiseReductionLevel: 100 });
    // Load from the app's own files instead of the package's CDN.
    const base = new URL("./df3/", document.baseURI);
    const wasm = new URL("df_bg.wasm", base).href;
    const model = new URL("DeepFilterNet3.bin", base).href;
    (core as unknown as { assetLoader: unknown }).assetLoader = {
      getAssetUrls: () => ({ wasm, model }),
      fetchAsset: async (url: string) => {
        if (url === model) return modelBytes(url);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`DeepFilterNet runtime: HTTP ${res.status}`);
        return res.arrayBuffer();
      },
    };
    await core.initialize();
    return core;
  })();
  return deepCore;
}

/**
 * Called when the app is idle after sign-in: the 16 MB runtime is fetched and
 * compiled before the first call instead of in the middle of joining it, when
 * the computer is also busy connecting and starting everyone's audio.
 */
export function prewarmDenoiser() {
  if (settings().noise !== "deep") return;
  void loadDeepCore().catch(() => {
    deepCore = null;
  });
}

export async function deepFilterNode(ctx: AudioContext): Promise<AudioNode> {
  try {
    const core = await loadDeepCore();
    await ctx.audioWorklet.addModule(cryptoShimUrl());
    return await core.createAudioWorkletNode(ctx);
  } catch (e) {
    deepCore = null; // a failed download may work next time
    throw e;
  }
}

let rnnoiseWasm: Promise<ArrayBuffer> | null = null;

async function rnnoiseNode(ctx: AudioContext): Promise<AudioNode> {
  const mod = await import("@sapphi-red/web-noise-suppressor");
  const [{ default: workletUrl }, { default: wasmUrl }, { default: simdUrl }] = await Promise.all([
    import("@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url"),
    import("@sapphi-red/web-noise-suppressor/rnnoise.wasm?url"),
    import("@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url"),
  ]);
  rnnoiseWasm ??= mod.loadRnnoise({ url: wasmUrl, simdUrl });
  await ctx.audioWorklet.addModule(workletUrl);
  return new mod.RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: await rnnoiseWasm });
}

/**
 * Mono fold-down. Many Windows mics/headsets deliver two channels even when
 * asked for one — often with the voice on the left only. Without this, RNNoise
 * (which processes one channel) and the stereo destination produce a track with
 * a silent right channel: everyone hears you in one ear. Folding to mono up
 * front keeps every stage and the published track centred.
 */
export function monoNode(ctx: BaseAudioContext): GainNode {
  const g = ctx.createGain();
  g.channelCount = 1;
  g.channelCountMode = "explicit";
  g.channelInterpretation = "speakers";
  return g;
}

export interface GateState {
  muted: boolean;
  pttDown: boolean;
}

export class MicProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = "nova-mic";
  processedTrack?: MediaStreamTrack;

  private ctx: AudioContext | null = null;
  private nodes: AudioNode[] = [];
  private input: GainNode | null = null;
  private gate: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private fx: EffectGraph | null = null;
  private buf: Float32Array<ArrayBuffer> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Bumped by every teardown: a build still awaiting RNNoise knows it was cancelled. */
  private generation = 0;
  private lastLoud = 0;
  private lastTalkMuted = 0;
  private noiseFloor = -60;
  /** Current input level in dBFS (for meters). */
  level = -100;
  /** User is speaking into a muted mic (for the hint). */
  talkingWhileMuted = false;

  constructor(private readonly state: () => GateState, private readonly onChange?: () => void) {}

  async init(opts: AudioProcessorOptions) {
    await this.build(opts.track);
  }

  async restart(opts: AudioProcessorOptions) {
    await this.teardown();
    await this.build(opts.track);
  }

  async destroy() {
    await this.teardown();
  }

  setInputVolume(percent: number) {
    if (this.input) this.input.gain.value = Math.min(2, Math.max(0, percent / 100));
  }

  /** Swap the voice effect while talking (no republish). */
  setEffect(effect: string, override?: VoiceParams) {
    const { ctx, gate, dest } = this;
    if (!ctx || !gate || !dest) return;
    try {
      gate.disconnect();
    } catch {
      /* not connected yet */
    }
    this.fx?.dispose();
    this.fx = buildEffect(ctx, effect, override);
    gate.connect(this.fx.input);
    this.fx.output.connect(dest);
  }

  /**
   * Soundboard: mixes a clip into the outgoing track after the denoiser, the
   * gate and the voice effect — it is heard as it is, even while the mic is
   * muted. Null when the chain isn't running. Returns a stop function.
   */
  playClip(buffer: AudioBuffer, gain = 1): (() => void) | null {
    const { ctx, dest } = this;
    if (!ctx || !dest) return null;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(dest);
    this.nodes.push(g);
    src.onended = () => {
      g.disconnect();
      this.nodes = this.nodes.filter((n) => n !== g);
    };
    src.start();
    return () => {
      try {
        src.stop();
      } catch {
        /* already over */
      }
    };
  }

  /** Which denoiser actually runs (the deep one falls back to RNNoise if it can't load). */
  denoiser: "deep" | "rnnoise" | "none" = "none";

  private async build(track: MediaStreamTrack) {
    const gen = this.generation;
    // RNNoise is trained at 48 kHz — run our own context at that rate.
    const ctx = new AudioContext({ sampleRate: 48_000, latencyHint: "interactive" });
    this.ctx = ctx;
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    const mono = monoNode(ctx);
    // Rumble below the voice (desk bumps, hum) only confuses the denoiser and the gate.
    const rumble = ctx.createBiquadFilter();
    rumble.type = "highpass";
    rumble.frequency.value = 85;
    src.connect(mono).connect(rumble);
    let head: AudioNode = rumble;
    this.nodes = [src, mono, rumble];
    this.denoiser = "none";
    let mode = settings().noise;
    if (mode === "deep") {
      try {
        const df = await deepFilterNode(ctx);
        if (gen !== this.generation) return;
        head.connect(df);
        head = df;
        this.nodes.push(df);
        this.denoiser = "deep";
      } catch (e) {
        if (gen !== this.generation) return;
        console.warn("[mic] DeepFilterNet unavailable, falling back to RNNoise", e);
        mode = "rnnoise";
      }
    }
    if (mode === "rnnoise") {
      try {
        const rn = await rnnoiseNode(ctx);
        // Left the channel while the model loaded: the context is closed, stop here.
        if (gen !== this.generation) return void (rn as { destroy?: () => void }).destroy?.();
        head.connect(rn);
        head = rn;
        this.nodes.push(rn);
        this.denoiser = "rnnoise";
      } catch (e) {
        if (gen !== this.generation) return;
        console.warn("[mic] RNNoise unavailable, continuing without it", e);
      }
    }
    const input = ctx.createGain();
    input.gain.value = Math.min(2, (settings().inputVolume ?? 100) / 100);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.2;
    const gate = ctx.createGain();
    gate.gain.value = 0;
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 1; // a mono track: receivers play it in both ears
    head.connect(input);
    input.connect(analyser);
    input.connect(gate);
    this.nodes.push(input, analyser, gate, dest);
    this.input = input;
    this.gate = gate;
    this.analyser = analyser;
    this.dest = dest;
    this.setEffect(settings().voiceEffect);
    this.buf = new Float32Array(analyser.fftSize);
    this.processedTrack = dest.stream.getAudioTracks()[0];
    void ctx.resume().catch(() => {});
    this.timer = setInterval(() => this.tick(), 20);
  }

  private tick() {
    const a = this.analyser;
    const g = this.gate;
    const ctx = this.ctx;
    if (!a || !g || !ctx || !this.buf) return;
    a.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(sum / this.buf.length);
    const db = rms > 0 ? 20 * Math.log10(rms) : -100;
    this.level = db;

    const s = settings();
    const st = this.state();
    const now = performance.now();

    // Automatic threshold: track the noise floor, open ~12 dB above it.
    if (db < this.noiseFloor) this.noiseFloor = this.noiseFloor * 0.8 + db * 0.2;
    else this.noiseFloor += 0.02;
    this.noiseFloor = Math.max(-80, Math.min(-35, this.noiseFloor));
    const threshold = s.sensitivityAuto ? this.noiseFloor + 12 : s.sensitivityDb;
    const loud = db > threshold;

    if (st.muted && db > Math.max(threshold, -45)) this.lastTalkMuted = now;
    const talkingMuted = st.muted && now - this.lastTalkMuted < 1500;
    if (talkingMuted !== this.talkingWhileMuted) {
      this.talkingWhileMuted = talkingMuted;
      this.onChange?.();
    }

    let open: boolean;
    if (st.muted) open = false;
    else if (s.inputMode === "ptt") open = st.pttDown;
    else {
      if (loud) this.lastLoud = now;
      open = now - this.lastLoud < 280; // hold: don't chop word endings
    }
    const target = open ? 1 : 0;
    if (Math.abs(g.gain.value - target) > 0.01) g.gain.setTargetAtTime(target, ctx.currentTime, open ? 0.004 : 0.04);
  }

  private async teardown() {
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* already gone */
      }
      (n as { destroy?: () => void }).destroy?.();
    }
    this.nodes = [];
    this.fx?.dispose();
    this.fx = null;
    this.dest = null;
    this.processedTrack?.stop();
    this.processedTrack = undefined;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) await ctx.close().catch(() => {});
  }
}

/**
 * Mic test for settings: the same chain, played back to the user. `preview`
 * hears a voice preset still being edited instead of the chosen effect; the
 * returned function stops the test, and `.update` changes the preview live.
 */
export async function startMicTest(onLevel: (db: number) => void, preview?: VoiceParams): Promise<(() => void) & { update(p: VoiceParams): void }> {
  const s = settings();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: s.inputDevice ? { exact: s.inputDevice } : undefined,
      echoCancellation: s.echoCancellation,
      noiseSuppression: s.noise === "standard",
      autoGainControl: s.autoGain,
    },
  });
  const proc = new MicProcessor(() => ({ muted: false, pttDown: true }));
  await proc.init({ kind: "audio" as Track.Kind.Audio, track: stream.getAudioTracks()[0], audioContext: undefined as unknown as AudioContext });
  if (preview) proc.setEffect("preview", preview);
  const out = new Audio();
  out.srcObject = new MediaStream([proc.processedTrack!]);
  const sinkable = out as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  if (s.outputDevice && sinkable.setSinkId) await sinkable.setSinkId(s.outputDevice).catch(() => {});
  void out.play().catch(() => {});
  const id = setInterval(() => onLevel(proc.level), 50);
  const stop = () => {
    clearInterval(id);
    out.pause();
    out.srcObject = null;
    void proc.destroy();
    stream.getTracks().forEach((t) => t.stop());
  };
  return Object.assign(stop, { update: (p: VoiceParams) => proc.setEffect("preview", p) });
}
