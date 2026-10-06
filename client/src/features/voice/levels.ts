// Per-frame audio levels for the speaking aura. Written straight into a CSS
// variable on the element (no React state), so dozens of tiles cost nothing.
import { useEffect, type RefObject } from "react";
import { createAudioAnalyser, type RemoteAudioTrack } from "livekit-client";
import { getRoom, micLevel, useVoice, voicePublication } from "./voice";
import { useSettings } from "../../store/settings";

const analysers = new Map<string, { calc: () => number; cleanup: () => Promise<void> | void }>();

function remoteLevel(userId: string): number {
  const room = getRoom();
  const p = room?.remoteParticipants.get(userId);
  const pub = p ? voicePublication(p) : undefined;
  const track = pub?.track as RemoteAudioTrack | undefined;
  if (!track || pub?.isMuted) return 0;
  const key = track.sid ?? userId;
  let a = analysers.get(key);
  if (!a) {
    try {
      const x = createAudioAnalyser(track, { cloneTrack: true, fftSize: 512, smoothingTimeConstant: 0.3 });
      a = { calc: x.calculateVolume, cleanup: x.cleanup };
      analysers.set(key, a);
    } catch {
      return p?.audioLevel ?? 0;
    }
  }
  return Math.min(1, a.calc() * 2.2);
}

export function releaseAnalysers() {
  for (const a of analysers.values()) void a.cleanup();
  analysers.clear();
}

useVoice.subscribe((s, prev) => {
  if (s.channelId !== prev.channelId || s.rev !== prev.rev) {
    // Drop analysers of tracks that are gone.
    const room = getRoom();
    const live = new Set<string>();
    room?.remoteParticipants.forEach((p) => p.audioTrackPublications.forEach((pub) => pub.track?.sid && live.add(pub.track.sid)));
    for (const [k, a] of analysers) if (!live.has(k)) {
      void a.cleanup();
      analysers.delete(k);
    }
  }
});

export function levelOf(userId: string, isMe: boolean): number {
  const v = useVoice.getState();
  if (isMe) {
    if (v.muted || v.deafened) return 0;
    if (useSettings.getState().inputMode === "ptt" && !v.pttDown) return 0;
    const db = micLevel();
    return Math.max(0, Math.min(1, (db + 55) / 40));
  }
  return remoteLevel(userId);
}

/** Drive `--level` + data-speaking on an element for the given participant. */
export function useAura(ref: RefObject<HTMLElement | null>, userId: string, isMe: boolean, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    let smooth = 0;
    let last = 0;
    const loop = (ts: number) => {
      raf = requestAnimationFrame(loop);
      if (ts - last < 33) return; // ~30 fps is plenty for a glow
      last = ts;
      const el = ref.current;
      if (!el) return;
      const target = levelOf(userId, isMe);
      smooth = target > smooth ? smooth * 0.4 + target * 0.6 : smooth * 0.82 + target * 0.18;
      el.style.setProperty("--level", smooth.toFixed(3));
      const speaking = smooth > 0.06 || !!useVoice.getState().speaking[userId];
      if (el.dataset.speaking !== String(speaking)) el.dataset.speaking = String(speaking);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [ref, userId, isMe, enabled]);
}
