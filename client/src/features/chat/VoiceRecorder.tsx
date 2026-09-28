// Voice messages: record with MediaRecorder (Opus), compute a 64-point
// waveform, upload, send. Click to start/stop; Esc or trash cancels.
import { useEffect, useRef, useState } from "react";
import { Mic, Send, Trash2 } from "lucide-react";
import { t } from "../../lib/i18n";
import { fmtClock } from "../../lib/time";
import { toast } from "../../lib/bus";
import { settings } from "../../store/settings";
import { monoNode } from "../voice/processor";

export async function computeWaveform(blob: Blob, points = 64): Promise<{ waveform: string; duration: number }> {
  const ctx = new AudioContext();
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const data = buf.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / points));
    const out = new Uint8Array(points);
    let max = 0;
    const vals: number[] = [];
    for (let i = 0; i < points; i++) {
      let sum = 0;
      for (let j = i * step; j < Math.min(data.length, (i + 1) * step); j++) sum += Math.abs(data[j]);
      const v = sum / step;
      vals.push(v);
      max = Math.max(max, v);
    }
    vals.forEach((v, i) => (out[i] = Math.round((v / (max || 1)) * 255)));
    return { waveform: btoa(String.fromCharCode(...out)), duration: buf.duration };
  } finally {
    void ctx.close();
  }
}

export function VoiceRecorder({ onDone, onCancel }: { onDone: (blob: Blob, duration: number, waveform: string) => void; onCancel: () => void }) {
  const [elapsed, setElapsed] = useState(0);
  const [bars, setBars] = useState<number[]>([]);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const started = useRef(0);
  const cancelled = useRef(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let ctx: AudioContext | null = null;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: settings().inputDevice ?? undefined, echoCancellation: true, noiseSuppression: true } });
      } catch {
        toast(t("errors.microphone_denied"), "error");
        return onCancel();
      }
      // Record a mono mix: a "stereo" mic with the voice on one side would
      // otherwise produce one-ear voice messages.
      ctx = new AudioContext();
      const mono = monoNode(ctx);
      const dest = ctx.createMediaStreamDestination();
      dest.channelCount = 1;
      ctx.createMediaStreamSource(stream).connect(mono);
      mono.connect(dest);
      const mime = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
      const r = new MediaRecorder(dest.stream, mime ? { mimeType: mime, audioBitsPerSecond: 48_000 } : undefined);
      rec.current = r;
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      r.onstop = async () => {
        stream?.getTracks().forEach((x) => x.stop());
        if (cancelled.current) return;
        const blob = new Blob(chunks.current, { type: r.mimeType || "audio/webm" });
        const secs = (Date.now() - started.current) / 1000;
        if (secs < 0.7) {
          toast(t("chat.voiceTooShort"));
          return onCancel();
        }
        try {
          const { waveform, duration } = await computeWaveform(blob);
          onDone(blob, duration || secs, waveform);
        } catch {
          onDone(blob, secs, "");
        }
      };
      r.start(250);
      started.current = Date.now();
      const an = ctx.createAnalyser();
      an.fftSize = 256;
      mono.connect(an);
      const d = new Uint8Array(an.frequencyBinCount);
      let lastBar = 0;
      const loop = (ts: number) => {
        raf = requestAnimationFrame(loop);
        setElapsed((Date.now() - started.current) / 1000);
        if (ts - lastBar < 80) return;
        lastBar = ts;
        an.getByteTimeDomainData(d);
        let peak = 0;
        for (const v of d) peak = Math.max(peak, Math.abs(v - 128) / 128);
        setBars((b) => [...b.slice(-47), Math.min(1, peak * 2.5)]);
      };
      raf = requestAnimationFrame(loop);
    })();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      cancelAnimationFrame(raf);
      void ctx?.close();
      if (rec.current?.state === "recording") {
        cancelled.current = true;
        rec.current.stop();
      }
      stream?.getTracks().forEach((x) => x.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stop = () => rec.current?.state === "recording" && rec.current.stop();
  const cancel = () => {
    cancelled.current = true;
    rec.current?.state === "recording" && rec.current.stop();
    onCancel();
  };

  return (
    <div className="flex h-11 flex-1 items-center gap-3 px-2">
      <button onClick={cancel} className="rounded-lg p-2 text-fg-3 hover:bg-bad/15 hover:text-bad" aria-label={t("common.cancel")}>
        <Trash2 size={18} />
      </button>
      <span className="flex items-center gap-2 text-[14px] font-semibold text-bad">
        <Mic size={16} className="animate-pulse" /> {fmtClock(elapsed)}
      </span>
      <div className="flex h-8 flex-1 items-center gap-[3px] overflow-hidden">
        {bars.map((b, i) => (
          <span key={i} className="w-[3px] shrink-0 rounded-full bg-star" style={{ height: `${Math.max(12, b * 100)}%`, opacity: 0.4 + b * 0.6 }} />
        ))}
      </div>
      <button onClick={stop} className="star-fill flex h-9 w-9 items-center justify-center rounded-full" aria-label={t("common.send")}>
        <Send size={16} />
      </button>
    </div>
  );
}
