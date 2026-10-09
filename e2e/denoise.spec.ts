// The deep noise suppressor (DeepFilterNet3 + speech guard), measured on real
// speech: it must take the noise away without taking quiet parts of the voice
// with it. (Until 1.7.5 it turned 20–27 % of the speech down by over 6 dB and
// erased syllables in loud noise; now 1–3 %.) The speech is a Russian TTS
// phrase, with a microphone's own hiss under it.
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { openAs, register } from "./helpers";

const RATE = 48_000;
const F = 480; // 10 ms frames

/** Russian speech, 16-bit mono WAV, as base64 for the page to decode at 48 kHz. */
const speechWav = readFileSync(new URL("./fixtures/speech-ru.wav", import.meta.url)).toString("base64");

const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-7));
const frames = (a: Float32Array, off: number, n: number) =>
  Array.from({ length: n }, (_, i) => {
    let s = 0;
    for (let j = 0; j < F; j++) s += (a[off + i * F + j] ?? 0) ** 2;
    return Math.sqrt(s / F);
  });

/** Lag (samples) of `b` behind `a` with the best correlation, searched around `guess`. */
function lagOf(a: Float32Array, b: Float32Array, guess: number, span: number, from: number, len = RATE * 4) {
  let best = guess;
  let bestC = -Infinity;
  for (let L = guess - span; L <= guess + span; L++) {
    let c = 0, ea = 0, eb = 0;
    for (let i = from; i < from + len; i += 3) {
      const x = a[i] ?? 0, y = b[i + L] ?? 0;
      c += x * y; ea += x * x; eb += y * y;
    }
    const r = c / Math.sqrt(ea * eb + 1e-12);
    if (r > bestC) [bestC, best] = [r, L];
  }
  return best;
}

/** Lag (in 10 ms frames) of `b` behind `a`, from the correlation of their loudness. */
function frameLag(a: Float32Array, b: Float32Array, max = 400) {
  const la = frames(a, 0, Math.floor(a.length / F)).map((x) => Math.max(db(x), -60));
  const lb = frames(b, 0, Math.floor(b.length / F)).map((x) => Math.max(db(x), -60));
  let best = 0;
  let bestC = -Infinity;
  for (let L = 0; L < max; L++) {
    const n = Math.min(la.length, lb.length - L);
    if (n < 300) break;
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let i = 0; i < n; i++) {
      const x = la[i], y = lb[i + L];
      sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y;
    }
    const c = (sab - (sa * sb) / n) / Math.sqrt((saa - (sa * sa) / n) * (sbb - (sb * sb) / n));
    if (c > bestC) [bestC, best] = [c, L];
  }
  return best;
}

/**
 * Plays the phrase (plus pink noise `snr` dB under it, or typing) through the app's own
 * microphone chain with the deep denoiser and records the signal before and
 * after it. Returns the clean speech as played and both recordings.
 */
async function runChain(page: Page, noise: { snr?: number; keys?: boolean }) {
  const out = await page.evaluate(
    async ([wav, snr, keys]) => {
      const url = performance.getEntriesByType("resource").map((e) => e.name).find((x) => x.includes("/src/features/voice/processor.ts")) ?? "/src/features/voice/processor.ts";
      const m = await import(/* @vite-ignore */ url);
      const play = new AudioContext({ sampleRate: 48_000 });
      const bin = atob(wav);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const speech = await play.decodeAudioData(bytes.buffer);
      const clean = speech.getChannelData(0);
      // Speech at a usual microphone level (-26 dBFS over its active parts), noise below it by `snr` dB.
      let act = 0, cnt = 0;
      for (let i = 0; i + 480 <= clean.length; i += 480) {
        let e = 0;
        for (let j = 0; j < 480; j++) e += clean[i + j] ** 2;
        if (e / 480 > 1e-4) [act, cnt] = [act + e / 480, cnt + 1];
      }
      const gain = 0.05 / Math.sqrt(act / cnt);
      for (let i = 0; i < clean.length; i++) clean[i] *= gain;
      const mix = new Float32Array(clean);
      // A real microphone is never digitally silent: its own hiss, about -70 dBFS.
      let hs = 99;
      for (let i = 0; i < mix.length; i++) mix[i] += (((hs = (hs * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1) * 0.00055;
      if (snr != null) {
        let b0 = 0, b1 = 0, b2 = 0, seed = 7;
        const noise = new Float32Array(clean.length);
        let e = 0;
        for (let i = 0; i < noise.length; i++) {
          const w = ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
          b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
          noise[i] = b0 + b1 + b2 + w * 0.1848;
          e += noise[i] ** 2;
        }
        const k = 0.05 / Math.pow(10, snr / 20) / Math.sqrt(e / noise.length);
        for (let i = 0; i < mix.length; i++) mix[i] += noise[i] * k;
      }
      if (keys) {
        // Typing: a click every 90–260 ms, each a 15 ms burst peaking at -20 dBFS.
        let ks = 3;
        const r = () => (ks = (ks * 1664525 + 1013904223) >>> 0) / 4294967296;
        for (let at = 2400; at < mix.length; at += 4300 + Math.floor(r() * 8200))
          for (let j = 0; j < 720 && at + j < mix.length; j++) mix[at + j] += (r() * 2 - 1) * 0.1 * Math.exp(-j / 150);
      }
      const buf = play.createBuffer(1, mix.length, 48_000);
      buf.copyToChannel(mix, 0);
      const dst = play.createMediaStreamDestination();
      const proc = new m.MicProcessor(() => ({ muted: false, pttDown: false }));
      await proc.init({ kind: "audio", track: dst.stream.getAudioTracks()[0] });
      const p = proc as unknown as { ctx: AudioContext; nodes: AudioNode[]; input: GainNode; denoiser: string };
      const rec = `registerProcessor("rec", class extends AudioWorkletProcessor { process(i) { if (i[0][0]) this.port.postMessage([i[0][0].slice(), i[1][0] ? i[1][0].slice() : new Float32Array(128)]); return true; } });`;
      await p.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([rec], { type: "application/javascript" })));
      const node = new AudioWorkletNode(p.ctx, "rec", { numberOfInputs: 2, numberOfOutputs: 0, channelCount: 1, channelCountMode: "explicit" });
      const chunks: Float32Array[][] = [];
      node.port.onmessage = (e) => chunks.push(e.data);
      p.nodes[2].connect(node, 0, 0); // into the denoiser (after the rumble filter)
      p.input.connect(node, 0, 1); // out of it
      const src = play.createBufferSource();
      src.buffer = buf;
      src.connect(dst);
      await new Promise((r) => setTimeout(r, 1000));
      src.start();
      await new Promise((r) => (src.onended = r));
      await new Promise((r) => setTimeout(r, 400));
      await proc.destroy();
      await play.close();
      const join = (k: number) => {
        const a = new Float32Array(chunks.length * 128);
        chunks.forEach((c, i) => a.set(c[k], i * 128));
        return Array.from(a);
      };
      return { denoiser: p.denoiser, clean: Array.from(clean), pre: join(0), post: join(1), delay: m.DEEP_DELAY as number };
    },
    [speechWav, noise.snr ?? null, !!noise.keys] as const
  );
  return { ...out, clean: Float32Array.from(out.clean), pre: Float32Array.from(out.pre), post: Float32Array.from(out.post) };
}

test("deep noise suppression removes the noise but not the quiet parts of speech", async ({ browser, request }) => {
  test.skip(!!process.env.E2E_URL, "imports modules through the dev server");
  test.setTimeout(120_000);
  const u = await register(request, "Шумодав");
  const s = await openAs(browser, u, "/", { local: { noise: "deep" } });

  for (const [name, noise] of [["clean", {}], ["fan", { snr: 15 }], ["typing", { keys: true }]] as const) {
    const r = await runChain(s.page, noise);
    expect(r.denoiser).toBe("deep");
    // Where the phrase starts in the recording, then the denoiser's own delay: the guard must line up with it.
    const start = lagOf(r.clean, r.pre, frameLag(r.clean, r.pre) * F, F, RATE * 2);
    const delay = lagOf(r.pre, r.post, r.delay, 600, start + RATE * 2);
    expect(delay, `${name}: the denoiser's delay`).toBe(r.delay);

    const n = Math.floor(r.clean.length / F) - 2;
    const clean = frames(r.clean, 0, n), pre = frames(r.pre, start, n), post = frames(r.post, start + delay, n);
    const peak = Math.max(...clean);
    const speech = clean.map((x, i) => (db(x) > db(peak) - 30 ? i : -1)).filter((i) => i >= 0);
    const pauses = clean.map((x, i) => (db(x) < db(peak) - 60 ? i : -1)).filter((i) => i >= 0);
    // Each frame against the speech as it went in (the chain's level from mic to denoiser taken out).
    const inGain = speech.map((i) => db(pre[i]) - db(clean[i])).sort((a, b) => a - b)[speech.length >> 1];
    const weakened = speech.filter((i) => db(post[i]) - db(clean[i]) - inGain < -6).length / speech.length;
    console.log(`${name}: speech weakened by over 6 dB in ${(weakened * 100).toFixed(1)} % of frames`);
    // Recorded in real time beside a busy browser, the same build measures 1–6 %; the old
    // tuning measured 16–27 %. 8 % keeps clear of the noise and still catches that.
    expect(weakened, `${name}: share of speech turned down by over 6 dB`).toBeLessThan(0.08);
    if (name !== "clean") {
      // The noise in the pauses: its middle for the fan, its loudest tenth (the clicks themselves) for typing.
      const at = name === "typing" ? 0.9 : 0.5;
      const q = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length * at)];
      const before = q(pauses.map((i) => db(pre[i])));
      const after = q(pauses.map((i) => db(post[i])));
      console.log(`${name}: noise in the pauses ${before.toFixed(0)} → ${after.toFixed(0)} dBFS`);
      expect(before - after, `${name}: noise taken out of the pauses`).toBeGreaterThan(15);
    }
  }
  await s.context.close();
});
