// Outgoing microphone chain, plugged into LiveKit as a track processor:
//
//   device → [RNNoise] → input gain → (analyser tap) → gate → published track
//
// The gate implements voice activation ("sensitivity") and push-to-talk by
// ramping gain — instant, glitch-free, and no track republish/renegotiation.
// The analyser sits before the gate, so we can still tell the user they're
// talking into a muted mic.
import type { Track } from "livekit-client";
import type { AudioProcessorOptions, TrackProcessor } from "livekit-client";
import { settings } from "../../store/settings";

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
  private buf: Float32Array<ArrayBuffer> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
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

  private async build(track: MediaStreamTrack) {
    // RNNoise is trained at 48 kHz — run our own context at that rate.
    const ctx = new AudioContext({ sampleRate: 48_000, latencyHint: "interactive" });
    this.ctx = ctx;
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    const mono = monoNode(ctx);
    src.connect(mono);
    let head: AudioNode = mono;
    this.nodes = [src, mono];
    if (settings().noise === "rnnoise") {
      try {
        const rn = await rnnoiseNode(ctx);
        head.connect(rn);
        head = rn;
        this.nodes.push(rn);
      } catch (e) {
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
    gate.connect(dest);
    this.nodes.push(input, analyser, gate, dest);
    this.input = input;
    this.gate = gate;
    this.analyser = analyser;
    this.buf = new Float32Array(analyser.fftSize);
    this.processedTrack = dest.stream.getAudioTracks()[0];
    void ctx.resume();
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
    this.processedTrack?.stop();
    this.processedTrack = undefined;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) await ctx.close().catch(() => {});
  }
}

/** Mic test for settings: the same chain, played back to the user. */
export async function startMicTest(onLevel: (db: number) => void): Promise<() => void> {
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
  const out = new Audio();
  out.srcObject = new MediaStream([proc.processedTrack!]);
  const sinkable = out as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  if (s.outputDevice && sinkable.setSinkId) await sinkable.setSinkId(s.outputDevice).catch(() => {});
  void out.play().catch(() => {});
  const id = setInterval(() => onLevel(proc.level), 50);
  return () => {
    clearInterval(id);
    out.pause();
    out.srcObject = null;
    void proc.destroy();
    stream.getTracks().forEach((t) => t.stop());
  };
}
