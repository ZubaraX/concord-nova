// Screen-share audio from the Windows app's nova-loopback helper: raw PCM
// arrives over IPC and is turned back into a MediaStreamTrack here, which
// voice.ts publishes as the screen share's audio. (Plain system loopback would
// include Nova's own playback — everyone heard themselves.)

const RATE = 48_000;

// A ring buffer that plays whatever arrived, with a little cushion against
// IPC jitter, and never lets the delay grow (it drops the oldest audio instead).
const WORKLET = `
class NovaPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = ${RATE};
    this.l = new Float32Array(this.size);
    this.r = new Float32Array(this.size);
    this.w = 0; this.rd = 0; this.n = 0; this.primed = false;
    this.port.onmessage = (e) => {
      const s = new Int16Array(e.data);
      const frames = s.length >> 1;
      for (let i = 0; i < frames; i++) {
        this.l[this.w] = s[2 * i] / 32768;
        this.r[this.w] = s[2 * i + 1] / 32768;
        this.w = (this.w + 1) % this.size;
      }
      this.n = Math.min(this.size, this.n + frames);
      if (this.n > ${RATE / 4}) { // over 250 ms behind: catch up to 80 ms
        const drop = this.n - ${(RATE * 0.08) | 0};
        this.rd = (this.rd + drop) % this.size;
        this.n -= drop;
      }
    };
  }
  process(_in, out) {
    const L = out[0][0], R = out[0][1] || out[0][0];
    if (!this.primed && this.n < ${(RATE * 0.06) | 0}) { L.fill(0); R.fill(0); return true; }
    this.primed = true;
    for (let i = 0; i < L.length; i++) {
      if (this.n > 0) {
        L[i] = this.l[this.rd]; R[i] = this.r[this.rd];
        this.rd = (this.rd + 1) % this.size; this.n--;
      } else { L[i] = 0; R[i] = 0; this.primed = false; }
    }
    return true;
  }
}
registerProcessor("nova-pcm", NovaPcm);
`;

interface Player {
  ctx: AudioContext;
  dest: MediaStreamAudioDestinationNode;
  node: AudioWorkletNode | null;
  queue: ArrayBuffer[];
  track: MediaStreamTrack;
}

let player: Player | null = null;

function startPlayer() {
  stopPlayer();
  const ctx = new AudioContext({ sampleRate: RATE, latencyHint: "interactive" });
  const dest = ctx.createMediaStreamDestination();
  dest.channelCount = 2;
  const p: Player = { ctx, dest, node: null, queue: [], track: dest.stream.getAudioTracks()[0] };
  player = p;
  const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
  void ctx.audioWorklet
    .addModule(url)
    .then(() => {
      if (player !== p) return;
      const node = new AudioWorkletNode(ctx, "nova-pcm", { numberOfInputs: 0, outputChannelCount: [2] });
      node.connect(dest);
      for (const b of p.queue) node.port.postMessage(b, [b]);
      p.queue = [];
      p.node = node;
      void ctx.resume().catch(() => {});
    })
    .catch((e) => console.warn("[app-audio] worklet failed", e))
    .finally(() => URL.revokeObjectURL(url));
}

function stopPlayer() {
  const p = player;
  player = null;
  if (!p) return;
  p.track.stop();
  p.node?.disconnect();
  void p.ctx.close().catch(() => {});
}

function feed(pcm: Uint8Array) {
  const p = player;
  if (!p) return;
  // A copy with its own, aligned buffer: it is transferred to the worklet.
  const b = pcm.slice().buffer as ArrayBuffer;
  if (p.node) p.node.port.postMessage(b, [b]);
  else if (p.queue.length < 50) p.queue.push(b);
}

/** Listens to the desktop shell (call once at startup). */
export function installAppAudio(nova: NovaDesktop): () => void {
  if (!nova.onAppAudio) return () => {};
  return nova.onAppAudio((kind, pcm) => {
    if (kind === "start") startPlayer();
    else if (kind === "pcm" && pcm) feed(pcm);
    else if (kind === "end") stopPlayer();
  });
}

/** The track for the screen share being started, if the helper is streaming one. */
export function appAudioTrack(): MediaStreamTrack | null {
  return player && player.track.readyState === "live" ? player.track : null;
}

/** The share ended: stop the helper and the track. */
export function stopAppAudio() {
  window.nova?.stopAppAudio?.();
  stopPlayer();
}
