// Voice/video/screen over LiveKit (self-hosted SFU). The SFU handles ICE,
// TURN, simulcast, bandwidth adaptation and reconnection; this module adds the
// product layer: mic processing, mute/deafen/PTT, per-user volume, screen
// share presets, sounds, and self-healing rejoin after hard disconnects.
import { create } from "zustand";
import {
  ConnectionQuality,
  ConnectionState,
  DisconnectReason,
  LocalAudioTrack,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  type LocalTrackPublication,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type ScreenShareCaptureOptions,
  type TrackPublishOptions,
} from "livekit-client";
import { api, ApiError } from "../../lib/api";
import { bus, toast } from "../../lib/bus";
import { gw } from "../../lib/gateway";
import { errorText, t } from "../../lib/i18n";
import { voiceUrl } from "../../lib/server";
import { isAndroid, isDesktop } from "../../lib/platform";
import { playSound } from "../../lib/sound";
import { data } from "../../store/data";
import { settings, useSettings } from "../../store/settings";
import { MicProcessor } from "./processor";

export type Quality = "excellent" | "good" | "poor" | "lost" | "unknown";

export interface VoiceStore {
  channelId: string | null;
  state: "idle" | "connecting" | "connected" | "reconnecting" | "failed";
  muted: boolean;
  deafened: boolean;
  pttDown: boolean;
  cameraOn: boolean;
  screenOn: boolean;
  talkingWhileMuted: boolean;
  needsAudioUnlock: boolean;
  speaking: Record<string, boolean>;
  quality: Record<string, Quality>;
  /** Bumped when tracks change; media components re-query the room. */
  rev: number;
  joinedAt: number | null;
  focus: { userId: string; source: "camera" | "screen" } | null;
  reactions: { id: number; userId: string; emoji: string; x: number }[];
}

export const useVoice = create<VoiceStore>(() => ({
  channelId: null,
  state: "idle",
  muted: settings().joinMuted,
  deafened: false,
  pttDown: false,
  cameraOn: false,
  screenOn: false,
  talkingWhileMuted: false,
  needsAudioUnlock: false,
  speaking: {},
  quality: {},
  rev: 0,
  joinedAt: null,
  focus: null,
  reactions: [],
}));

const V = () => useVoice.getState();
const setV = (p: Partial<VoiceStore>) => useVoice.setState(p);

let room: Room | null = null;
let mic: MicProcessor | null = null;
let intentional = false;
let rejoinTries = 0;
const audioEls = new Map<string, HTMLMediaElement>();

export const getRoom = () => room;

const QUALITY: Record<ConnectionQuality, Quality> = {
  [ConnectionQuality.Excellent]: "excellent",
  [ConnectionQuality.Good]: "good",
  [ConnectionQuality.Poor]: "poor",
  [ConnectionQuality.Lost]: "lost",
  [ConnectionQuality.Unknown]: "unknown",
};

function bump() {
  setV({ rev: V().rev + 1 });
}

function reportSelf() {
  const s = V();
  gw.voiceSelf({ selfMute: s.muted || s.deafened, selfDeaf: s.deafened, selfVideo: s.cameraOn, selfStream: s.screenOn });
}

// ── volumes ──────────────────────────────────────────────────────────────────
function applyVolume(p: RemoteParticipant) {
  const s = settings();
  const deaf = V().deafened;
  const localMuted = !!s.localMutes[p.identity];
  const master = (s.outputVolume ?? 100) / 100;
  const v = deaf || localMuted ? 0 : ((s.userVolumes[p.identity] ?? 100) / 100) * master;
  const sv = deaf ? 0 : ((s.streamVolumes[p.identity] ?? 100) / 100) * master;
  p.setVolume(v, Track.Source.Microphone);
  p.setVolume(sv, Track.Source.ScreenShareAudio);
}

export function applyAllVolumes() {
  room?.remoteParticipants.forEach(applyVolume);
}

useSettings.subscribe((s, prev) => {
  if (s.userVolumes !== prev.userVolumes || s.streamVolumes !== prev.streamVolumes || s.localMutes !== prev.localMutes || s.outputVolume !== prev.outputVolume) applyAllVolumes();
  if (s.outputDevice !== prev.outputDevice && room) void room.switchActiveDevice("audiooutput", s.outputDevice ?? "default").catch(() => {});
  if (s.inputVolume !== prev.inputVolume) mic?.setInputVolume(s.inputVolume);
  if ((s.noise !== prev.noise || s.echoCancellation !== prev.echoCancellation || s.autoGain !== prev.autoGain || s.inputDevice !== prev.inputDevice) && room) void restartMic();
});

// ── mic ──────────────────────────────────────────────────────────────────────
function micCapture() {
  const s = settings();
  return {
    deviceId: s.inputDevice ?? undefined,
    echoCancellation: s.echoCancellation,
    // RNNoise replaces the browser suppressor — never double-process.
    noiseSuppression: s.noise === "standard",
    autoGainControl: s.autoGain,
    channelCount: 1,
  };
}

async function publishMic() {
  if (!room) return;
  mic = new MicProcessor(
    () => ({ muted: V().muted || V().deafened, pttDown: V().pttDown }),
    () => setV({ talkingWhileMuted: mic?.talkingWhileMuted ?? false })
  );
  try {
    await room.localParticipant.setMicrophoneEnabled(true, micCapture(), { dtx: true, red: true, audioPreset: { maxBitrate: 64_000 } } as TrackPublishOptions);
    const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone) as LocalTrackPublication | undefined;
    const track = pub?.track as LocalAudioTrack | undefined;
    if (track) await track.setProcessor(mic);
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === "NotAllowedError" || name === "SecurityError") toast(t("errors.microphone_denied"), "error");
    else if (name === "NotFoundError") toast(t("voice.noMic"), "error");
    else console.warn("[voice] mic failed", e);
  }
}

async function restartMic() {
  if (!room) return;
  const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
  if (pub?.track) await room.localParticipant.unpublishTrack(pub.track, true).catch(() => {});
  await mic?.destroy().catch(() => {});
  mic = null;
  await publishMic();
}

export function micLevel(): number {
  return mic?.level ?? -100;
}

// ── connect / disconnect ─────────────────────────────────────────────────────
function wire(r: Room) {
  r.on(RoomEvent.ParticipantConnected, () => {
    playSound("join");
    bump();
  })
    .on(RoomEvent.ParticipantDisconnected, (p) => {
      playSound("leave");
      const s = { ...V().speaking };
      delete s[p.identity];
      const focus = V().focus?.userId === p.identity ? null : V().focus;
      setV({ speaking: s, focus });
      bump();
    })
    .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub: RemoteTrackPublication, p: RemoteParticipant) => {
      if (track.kind === Track.Kind.Audio) {
        const el = track.attach();
        el.style.display = "none";
        document.body.appendChild(el);
        audioEls.set(track.sid ?? String(Math.random()), el);
        applyVolume(p);
      }
      if (track.source === Track.Source.ScreenShare && !V().focus) setV({ focus: { userId: p.identity, source: "screen" } });
      bump();
    })
    .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _pub, p) => {
      for (const el of track.detach()) el.remove();
      if (track.sid) audioEls.delete(track.sid);
      if (track.source === Track.Source.ScreenShare && V().focus?.userId === p.identity && V().focus?.source === "screen") setV({ focus: null });
      bump();
    })
    .on(RoomEvent.TrackMuted, bump)
    .on(RoomEvent.TrackUnmuted, bump)
    .on(RoomEvent.LocalTrackPublished, bump)
    .on(RoomEvent.LocalTrackUnpublished, (pub) => {
      if (pub.source === Track.Source.ScreenShare && V().screenOn) {
        setV({ screenOn: false });
        playSound("streamStop");
        reportSelf();
      }
      if (pub.source === Track.Source.Camera && V().cameraOn) {
        setV({ cameraOn: false });
        reportSelf();
      }
      bump();
    })
    .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
      const next: Record<string, boolean> = {};
      for (const p of speakers) next[p.identity] = true;
      setV({ speaking: next });
    })
    .on(RoomEvent.ConnectionQualityChanged, (q: ConnectionQuality, p: Participant) => {
      setV({ quality: { ...V().quality, [p.identity]: QUALITY[q] } });
    })
    .on(RoomEvent.Reconnecting, () => setV({ state: "reconnecting" }))
    .on(RoomEvent.Reconnected, () => {
      setV({ state: "connected" });
      gw.voiceSync(V().channelId);
      reportSelf();
    })
    .on(RoomEvent.AudioPlaybackStatusChanged, () => setV({ needsAudioUnlock: !r.canPlaybackAudio }))
    .on(RoomEvent.DataReceived, (payload, p) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload)) as { t: string; e?: string };
        if (msg.t === "emoji" && msg.e && p) addReaction(p.identity, msg.e);
      } catch {
        /* not ours */
      }
    })
    .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => void onDisconnected(reason));
}

async function onDisconnected(reason?: DisconnectReason) {
  const channelId = V().channelId;
  cleanup();
  if (intentional) return;
  if (reason === DisconnectReason.DUPLICATE_IDENTITY) {
    toast(t("voice.replacedElsewhere"));
    setV({ state: "idle", channelId: null });
    return;
  }
  if (reason === DisconnectReason.PARTICIPANT_REMOVED || reason === DisconnectReason.ROOM_DELETED) {
    toast(t("voice.removed"));
    setV({ state: "idle", channelId: null });
    playSound("disconnect");
    return;
  }
  // Unexpected drop that LiveKit couldn't resume (server restart, long outage):
  // rejoin a few times with backoff before giving up.
  if (channelId && rejoinTries < 4) {
    rejoinTries++;
    setV({ state: "reconnecting", channelId });
    setTimeout(() => {
      if (V().channelId === channelId && !intentional) void joinVoice(channelId, true);
    }, 1000 * rejoinTries * rejoinTries);
    return;
  }
  setV({ state: "failed" });
}

function cleanup() {
  for (const el of audioEls.values()) el.remove();
  audioEls.clear();
  void mic?.destroy().catch(() => {});
  mic = null;
  room?.removeAllListeners();
  room = null;
  setV({ cameraOn: false, screenOn: false, speaking: {}, quality: {}, focus: null, talkingWhileMuted: false, needsAudioUnlock: false, reactions: [] });
  bump();
}

export async function joinVoice(channelId: string, isRejoin = false) {
  if (!isRejoin && V().channelId === channelId && (V().state === "connected" || V().state === "connecting")) return;
  if (room) await leaveVoice(true);
  intentional = false;
  if (!isRejoin) rejoinTries = 0;
  setV({ channelId, state: isRejoin ? "reconnecting" : "connecting", joinedAt: isRejoin ? V().joinedAt : Date.now(), deafened: isRejoin ? V().deafened : false, muted: isRejoin ? V().muted : settings().joinMuted || V().muted });
  let join: { url: string | null; token: string };
  try {
    join = await api("/api/voice/join", { method: "POST", body: { channelId, selfMute: V().muted, selfDeaf: V().deafened } });
  } catch (e) {
    const err = e as ApiError;
    if (isRejoin && err.isNetwork) return void onDisconnected();
    setV({ state: "idle", channelId: null });
    toast(errorText(e), "error");
    return;
  }
  const s = settings();
  const r = new Room({
    adaptiveStream: true,
    dynacast: true,
    webAudioMix: true,
    stopLocalTrackOnUnpublish: true,
    disconnectOnPageLeave: true,
    audioOutput: s.outputDevice ? { deviceId: s.outputDevice } : undefined,
    audioCaptureDefaults: micCapture(),
    videoCaptureDefaults: { resolution: VideoPresets.h720.resolution, deviceId: s.videoDevice ?? undefined },
    publishDefaults: { simulcast: true, videoCodec: "vp8", screenShareSimulcastLayers: [], dtx: true, red: true },
  });
  room = r;
  wire(r);
  try {
    await r.connect(voiceUrl(join.url), join.token, { autoSubscribe: true });
  } catch (e) {
    console.warn("[voice] connect failed", e);
    if (room === r) {
      cleanup();
      if (isRejoin) return void onDisconnected();
      setV({ state: "failed" });
      toast(t("voice.failed"), "error");
    }
    return;
  }
  if (room !== r) return; // left meanwhile
  rejoinTries = 0;
  setV({ state: "connected", needsAudioUnlock: !r.canPlaybackAudio });
  if (!isRejoin) playSound("connect");
  await publishMic();
  if (r.state !== ConnectionState.Connected) return;
  applyAllVolumes();
  gw.voiceSync(channelId);
  reportSelf();
  bump();
}

export async function leaveVoice(silent = false) {
  intentional = true;
  const r = room;
  const was = V().channelId;
  setV({ channelId: null, state: "idle", joinedAt: null });
  if (r) await r.disconnect(true).catch(() => {});
  cleanup();
  if (was) gw.voiceSync(null);
  if (was && !silent) playSound("disconnect");
  if (isAndroid) void import("../../lib/android").then((m) => m.stopScreenCapture()).catch(() => {});
}

// ── controls ─────────────────────────────────────────────────────────────────
export function toggleMute() {
  const s = V();
  if (s.deafened) {
    setV({ deafened: false, muted: false });
    applyAllVolumes();
    playSound("undeafen");
  } else {
    setV({ muted: !s.muted });
    playSound(s.muted ? "unmute" : "mute");
  }
  reportSelf();
}

export function toggleDeafen() {
  const deaf = !V().deafened;
  setV({ deafened: deaf });
  applyAllVolumes();
  playSound(deaf ? "deafen" : "undeafen");
  reportSelf();
}

export function setPtt(down: boolean) {
  if (V().pttDown === down) return;
  setV({ pttDown: down });
}

export async function unlockAudio() {
  await room?.startAudio().catch(() => {});
  setV({ needsAudioUnlock: !room?.canPlaybackAudio });
}

export async function toggleCamera() {
  if (!room) return;
  const on = !V().cameraOn;
  try {
    await room.localParticipant.setCameraEnabled(on, { resolution: VideoPresets.h720.resolution, deviceId: settings().videoDevice ?? undefined, facingMode: "user" });
    setV({ cameraOn: on });
    reportSelf();
  } catch {
    toast(t("errors.camera_denied"), "error");
  }
}

export async function flipCamera() {
  const pub = room?.localParticipant.getTrackPublication(Track.Source.Camera);
  const track = pub?.track as import("livekit-client").LocalVideoTrack | undefined;
  if (!track) return;
  const facing = track.mediaStreamTrack.getSettings().facingMode === "environment" ? "user" : "environment";
  await track.restartTrack({ facingMode: facing }).catch(() => {});
  bump();
}

const SCREEN_PRESETS = {
  "720p30": { w: 1280, h: 720, fps: 30, bitrate: 2_500_000 },
  "1080p30": { w: 1920, h: 1080, fps: 30, bitrate: 4_500_000 },
  "1080p60": { w: 1920, h: 1080, fps: 60, bitrate: 7_500_000 },
  "1440p60": { w: 2560, h: 1440, fps: 60, bitrate: 12_000_000 },
  source: { w: 0, h: 0, fps: 60, bitrate: 16_000_000 },
} as const;

export async function toggleScreen(opts?: { audio?: boolean }) {
  if (!room) return;
  if (V().screenOn) {
    await room.localParticipant.setScreenShareEnabled(false).catch(() => {});
    if (isAndroid) void import("../../lib/android").then((m) => m.stopScreenCapture());
    setV({ screenOn: false });
    playSound("streamStop");
    reportSelf();
    return;
  }
  const preset = SCREEN_PRESETS[settings().screenQuality] ?? SCREEN_PRESETS["1080p30"];
  const publish: TrackPublishOptions = {
    videoCodec: "h264",
    simulcast: false,
    screenShareEncoding: { maxBitrate: preset.bitrate, maxFramerate: preset.fps, priority: "high" },
    degradationPreference: preset.fps >= 60 ? "maintain-framerate" : "maintain-resolution",
  };
  try {
    if (isAndroid) {
      const { startScreenCapture } = await import("../../lib/android");
      const track = await startScreenCapture(() => {
        if (V().screenOn) void toggleScreen();
      });
      await room.localParticipant.publishTrack(track, { ...publish, source: Track.Source.ScreenShare, videoCodec: "vp8" });
    } else {
      const capture: ScreenShareCaptureOptions = {
        audio: opts?.audio ?? true,
        systemAudio: "include",
        selfBrowserSurface: "exclude",
        surfaceSwitching: "include",
        contentHint: preset.fps >= 60 ? "motion" : "detail",
        resolution: preset.w ? { width: preset.w, height: preset.h, frameRate: preset.fps } : { width: 3840, height: 2160, frameRate: preset.fps },
      };
      await room.localParticipant.setScreenShareEnabled(true, capture, publish);
    }
    setV({ screenOn: true });
    playSound("streamStart");
    reportSelf();
  } catch (e) {
    const name = (e as Error)?.name;
    if (name !== "NotAllowedError" && name !== "AbortError") toast(t("errors.screen_failed"), "error");
  }
}

export async function switchInput(deviceId: string | null) {
  settings().setLocal({ inputDevice: deviceId });
}

export function sendReaction(emoji: string) {
  const me = data().me?.id;
  if (!room || !me) return;
  void room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ t: "emoji", e: emoji })), { reliable: true });
  addReaction(me, emoji);
}

let rid = 0;
function addReaction(userId: string, emoji: string) {
  const id = ++rid;
  setV({ reactions: [...V().reactions.slice(-20), { id, userId, emoji, x: 10 + Math.random() * 80 }] });
  setTimeout(() => setV({ reactions: V().reactions.filter((r) => r.id !== id) }), 3200);
}

// ── media lookup for tiles ───────────────────────────────────────────────────
export function trackFor(userId: string, source: "camera" | "screen"): Track | undefined {
  if (!room) return;
  const src = source === "camera" ? Track.Source.Camera : Track.Source.ScreenShare;
  const p = room.localParticipant.identity === userId ? room.localParticipant : room.remoteParticipants.get(userId);
  const pub = p?.getTrackPublication(src);
  if (!pub || pub.isMuted || !pub.track) return;
  return pub.track;
}

export function isLocal(userId: string) {
  return room?.localParticipant.identity === userId;
}

// ── gateway hooks ────────────────────────────────────────────────────────────
bus.on("dispatch", (e) => {
  if (e.t === "VOICE_MOVE") {
    if (e.d.channelId) {
      toast(t("voice.moved"));
      void joinVoice(e.d.channelId);
    } else void leaveVoice();
  }
  if (e.t === "READY" && V().channelId) {
    gw.voiceSync(V().state === "connected" ? V().channelId : null);
    reportSelf();
  }
  if (e.t === "CHANNEL_DELETE" && e.d.id === V().channelId) void leaveVoice();
});

bus.on("logout", () => void leaveVoice(true));

// Push-to-talk (window focus) — the desktop app also forwards a global key.
function pttKey(e: KeyboardEvent, down: boolean) {
  const s = settings();
  if (s.inputMode !== "ptt" || !V().channelId) return;
  if (e.code !== s.pttKey || e.repeat) return;
  const tag = (e.target as HTMLElement)?.tagName;
  if (down && (tag === "INPUT" || tag === "TEXTAREA") && s.pttKey.startsWith("Key")) return;
  if (down) setPtt(true);
  else setTimeout(() => setPtt(false), s.pttReleaseMs);
}
window.addEventListener("keydown", (e) => pttKey(e, true));
window.addEventListener("keyup", (e) => pttKey(e, false));
window.addEventListener("blur", () => {
  if (V().pttDown && !isDesktop) setPtt(false);
});
