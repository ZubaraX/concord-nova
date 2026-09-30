import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import clsx from "clsx";
import { AnimatePresence, motion } from "motion/react";
import {
  Mic,
  MicOff,
  Headphones,
  HeadphoneOff,
  Video,
  VideoOff,
  MonitorUp,
  MonitorX,
  PhoneOff,
  Maximize2,
  Minimize2,
  MessageSquare,
  SmilePlus,
  SwitchCamera,
  Volume2,
  VolumeX,
  UserPlus,
  PictureInPicture2,
  Settings2,
} from "lucide-react";
import type { Track } from "livekit-client";
import { t } from "../../lib/i18n";
import { canShareScreen, isAndroid } from "../../lib/platform";
import { useIsMobile } from "../../lib/hooks";
import { channelTitle, displayName, useData, voiceMembers } from "../../store/data";
import { settings, useSettings } from "../../store/settings";
import { useUI } from "../../store/ui";
import { Popover, Tooltip, useContextMenu, usePopover, MenuList } from "../../components/ui/overlay";
import { Slider } from "../../components/ui/primitives";
import { UserAvatar } from "../../components/ui/avatar";
import { toggleLocalMute, userMenu } from "../shell/menus";
import { PingButton } from "./ConnectionStats";
import { SoundboardButton } from "./Soundboard";
import { flipCamera, isLocal, joinVoice, leaveVoice, sendReaction, toggleCamera, toggleDeafen, toggleMute, toggleScreen, trackFor, useVoice } from "./voice";
import { useAura } from "./levels";

// ── media ────────────────────────────────────────────────────────────────────
function TrackVideo({ track, mirror, contain }: { track: Track; mirror?: boolean; contain?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);
  return <video ref={ref} autoPlay playsInline muted className={clsx("h-full w-full", contain ? "object-contain" : "object-cover", mirror && "-scale-x-100")} />;
}

interface TileSpec {
  key: string;
  userId: string;
  /** ringing: a DM call recipient who hasn't answered yet. */
  source: "camera" | "screen" | "avatar" | "ringing";
}

const Tile = memo(function Tile({ spec, focused, small, onFocus, guildId }: { spec: TileSpec; focused?: boolean; small?: boolean; onFocus: () => void; guildId: string | null }) {
  useVoice((s) => s.rev);
  const vs = useData((s) => s.voiceStates[spec.userId]);
  const name = useData((s) => displayName(s, spec.userId, guildId));
  const me = useData((s) => s.me?.id === spec.userId);
  const quality = useVoice((s) => s.quality[spec.userId]);
  const auraRef = useRef<HTMLDivElement>(null);
  const tileRef = useRef<HTMLDivElement>(null);
  const ringing = spec.source === "ringing";
  useAura(spec.source === "screen" || ringing ? { current: null } : spec.source === "camera" ? tileRef : auraRef, spec.userId, me, spec.source !== "screen" && !ringing);
  const menu = useContextMenu();
  const track = spec.source === "camera" || spec.source === "screen" ? trackFor(spec.userId, spec.source) : undefined;
  const muted = vs?.selfMute || vs?.serverMute;
  const deaf = vs?.selfDeaf || vs?.serverDeaf;
  const localMuted = useSettings((s) => !!s.localMutes[spec.userId]);
  const toggleFullscreen = () => {
    const el = tileRef.current;
    if (!el) return;
    if (document.fullscreenElement === el) void document.exitFullscreen();
    else void el.requestFullscreen().catch(() => {});
  };

  return (
    <div
      ref={tileRef}
      onDoubleClick={onFocus}
      onClick={small ? onFocus : undefined}
      onContextMenu={(e) => menu(e, [...userMenu(spec.userId, guildId)])}
      className={clsx(
        "group relative flex h-full w-full items-center justify-center overflow-hidden rounded-2xl bg-raised/80 hairline",
        spec.source === "camera" && "aura",
        small && "cursor-pointer"
      )}
      data-speaking="false"
      data-user={ringing ? undefined : spec.userId}
      data-ringing={ringing ? spec.userId : undefined}
      data-source={spec.source}
      style={{ transition: "box-shadow 90ms linear" }}
    >
      {track ? (
        <TrackVideo track={track} mirror={me && spec.source === "camera" && !isAndroid} contain={spec.source === "screen"} />
      ) : (
        <>
          <div className="absolute inset-0 opacity-60" style={{ background: "radial-gradient(60% 60% at 50% 45%, rgb(var(--star) / 0.10), transparent 70%)" }} />
          <div ref={auraRef} className={clsx("relative rounded-full", ringing ? "animate-pulse opacity-70" : "aura")} data-speaking="false">
            <UserAvatar userId={spec.userId} size={small ? 44 : focused ? 128 : 84} showStatus={false} />
          </div>
        </>
      )}
      {spec.source === "screen" && (
        <span className="absolute left-3 top-3 rounded-md bg-bad px-1.5 text-[11px] font-bold leading-5 text-white">{t("voice.live")}</span>
      )}
      <div className="absolute bottom-2 left-2 flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-lg bg-canvas/75 px-2 py-1 text-[12.5px] font-semibold backdrop-blur">
        {spec.source === "screen" && <MonitorUp size={13} className="shrink-0 text-star" />}
        <span className="truncate">{name}</span>
        {ringing && <span className="shrink-0 font-medium text-fg-3">· {t("call.calling")}</span>}
        {spec.source !== "screen" && muted &&<MicOff size={13} className={clsx("shrink-0", vs?.serverMute ? "text-bad" : "text-fg-2")} />}
        {spec.source !== "screen" && deaf && <HeadphoneOff size={13} className="shrink-0 text-fg-2" />}
        {localMuted && !me && (
          <span title={t("voice.localMuted")} className="flex shrink-0">
            <VolumeX size={13} className="text-bad" />
          </span>
        )}
      </div>
      {quality === "poor" || quality === "lost" ? (
        <span className="absolute right-2 top-2 rounded-md bg-warn/90 px-1.5 text-[10.5px] font-bold leading-5 text-[#1a1200]">{quality === "lost" ? "!" : "⚠"}</span>
      ) : null}
      {!small && track && (
        // Always visible on touch screens, where there is no hover.
        <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100">
          {document.fullscreenEnabled && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggleFullscreen();
              }}
              className="rounded-lg bg-canvas/75 p-1.5 text-fg-2 hover:text-fg"
              aria-label={t("voice.fullscreen")}
              title={t("voice.fullscreen")}
            >
              <Maximize2 size={15} />
            </button>
          )}
          {document.pictureInPictureEnabled && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                void tileRef.current?.querySelector("video")?.requestPictureInPicture().catch(() => {});
              }}
              className="rounded-lg bg-canvas/75 p-1.5 text-fg-2 hover:text-fg"
              aria-label={t("voice.popout")}
              title={t("voice.popout")}
            >
              <PictureInPicture2 size={15} />
            </button>
          )}
        </div>
      )}
    </div>
  );
});

// ── layout ───────────────────────────────────────────────────────────────────
function gridFor(n: number, w: number, h: number) {
  let best = { cols: 1, rows: 1, size: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const tw = (w - (cols - 1) * 10) / cols;
    const th = (h - (rows - 1) * 10) / rows;
    const size = Math.min(tw, (th * 16) / 9);
    if (size > best.size) best = { cols, rows, size };
  }
  return best;
}

/** Content-box size of an element that may mount later (a callback ref, not an effect on first render). */
function useSize() {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const ref = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

// ── stage ────────────────────────────────────────────────────────────────────
const NOBODY: string[] = [];

export function VoiceStage({ channelId, compact, onToggleChat, chatOpen }: { channelId: string; compact?: boolean; onToggleChat?: () => void; chatOpen?: boolean }) {
  const connected = useVoice((s) => s.channelId === channelId);
  const state = useVoice((s) => s.state);
  const rev = useVoice((s) => s.rev);
  const focus = useVoice((s) => s.focus);
  const reactions = useVoice((s) => s.reactions);
  const members = useData(useShallow((s) => voiceMembers(s, channelId)));
  const ringing = useData(useShallow((s) => s.calls[channelId]?.ringing ?? NOBODY));
  const channel = useData((s) => s.channels[channelId]);
  const title = useData((s) => channelTitle(s, channel));
  const guildId = channel?.guildId ?? null;
  const root = useRef<HTMLDivElement>(null);
  const [area, { w, h }] = useSize();
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const on = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);

  const tiles: TileSpec[] = useMemo(() => {
    const out: TileSpec[] = [];
    for (const m of members) {
      out.push({ key: `${m.userId}:cam`, userId: m.userId, source: connected && trackFor(m.userId, "camera") ? "camera" : "avatar" });
      if (connected && (m.selfStream || trackFor(m.userId, "screen"))) out.push({ key: `${m.userId}:screen`, userId: m.userId, source: "screen" });
    }
    // A DM call being placed shows who is being called, not just yourself.
    for (const userId of ringing) if (!members.some((m) => m.userId === userId)) out.push({ key: `${userId}:ring`, userId, source: "ringing" });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, ringing, connected, rev]);

  if (!connected) {
    return (
      <div className="relative flex flex-1 flex-col items-center justify-center gap-6 overflow-hidden p-6 text-center">
        <div className="absolute inset-0" style={{ background: "radial-gradient(50% 50% at 50% 45%, rgb(var(--star) / 0.08), transparent 70%)" }} />
        <div className="relative font-display text-[26px] font-semibold tracking-[-0.02em]">{title}</div>
        {members.length ? (
          <div className="relative flex -space-x-3">
            {members.slice(0, 8).map((m) => (
              <UserAvatar key={m.userId} userId={m.userId} size={56} showStatus={false} className="rounded-full ring-4 ring-surface" />
            ))}
          </div>
        ) : (
          <p className="relative max-w-sm text-fg-2">{t("voice.alone")}</p>
        )}
        {members.length > 0 && <p className="relative text-[14px] text-fg-3">{t("voice.participants", { n: members.length })}</p>}
        <button onClick={() => void joinVoice(channelId)} className="star-fill relative rounded-2xl px-8 py-3.5 text-[16px] font-semibold shadow-star transition-transform hover:scale-[1.03] active:scale-95" disabled={state === "connecting"}>
          {state === "connecting" ? t("voice.connecting") : t("voice.joinChannel")}
        </button>
      </div>
    );
  }

  const focusKey = focus ? `${focus.userId}:${focus.source === "screen" ? "screen" : "cam"}` : null;
  const focused = focusKey ? tiles.find((x) => x.key === focusKey) : undefined;
  const rest = focused ? tiles.filter((x) => x !== focused) : tiles;
  const grid = gridFor(Math.max(1, tiles.length), w, h);

  return (
    <div ref={root} className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-canvas/40">
      {/* The bottom padding keeps tiles clear of the floating controls. */}
      <div ref={area} className={clsx("relative min-h-0 flex-1", compact ? "p-2 pb-[76px]" : "p-4 pb-24")}>
        {focused ? (
          <div className="flex h-full flex-col gap-2.5">
            <div className="min-h-0 flex-1">
              <Tile spec={focused} focused onFocus={() => useVoice.setState({ focus: null })} guildId={guildId} />
            </div>
            {rest.length > 0 && (
              <div className="scroll-thin flex h-[104px] shrink-0 gap-2.5 overflow-x-auto">
                {rest.map((sp) => (
                  <div key={sp.key} className="aspect-video h-full shrink-0">
                    <Tile spec={sp} small onFocus={() => useVoice.setState({ focus: { userId: sp.userId, source: sp.source === "screen" ? "screen" : "camera" } })} guildId={guildId} />
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="grid h-full content-center justify-center gap-2.5" style={{ gridTemplateColumns: `repeat(${grid.cols}, ${Math.floor(grid.size)}px)` }}>
            <AnimatePresence initial={false}>
              {tiles.map((sp) => (
                <motion.div
                  key={sp.key}
                  layout
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={{ type: "spring", stiffness: 380, damping: 32 }}
                  style={{ height: Math.floor((grid.size * 9) / 16) }}
                >
                  <Tile spec={sp} onFocus={() => useVoice.setState({ focus: { userId: sp.userId, source: sp.source === "screen" ? "screen" : "camera" } })} guildId={guildId} />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
        <PingButton compact placement="bottom-start" className={clsx("absolute z-10 bg-canvas/75 px-2 py-1 backdrop-blur", compact ? "left-3 top-3" : "left-5 top-5")} />
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          {reactions.map((r) => (
            <span key={r.id} className="absolute bottom-16 text-[34px]" style={{ left: `${r.x}%`, animation: "float-up 3s cubic-bezier(.2,.7,.3,1) forwards", ["--drift" as string]: `${(r.x - 50) / 3}px` }}>
              {r.emoji}
            </span>
          ))}
        </div>
      </div>
      <Controls channelId={channelId} compact={compact} fullscreen={fullscreen} onFullscreen={() => (document.fullscreenElement ? void document.exitFullscreen() : void root.current?.requestFullscreen())} onToggleChat={onToggleChat} chatOpen={chatOpen} guildId={guildId} />
    </div>
  );
}

const QUICK_REACTIONS = ["👍", "😂", "🔥", "❤️", "😮", "👏", "🎉", "💀"];

function Controls({
  channelId,
  compact,
  fullscreen,
  onFullscreen,
  onToggleChat,
  chatOpen,
  guildId,
}: {
  channelId: string;
  compact?: boolean;
  fullscreen: boolean;
  onFullscreen: () => void;
  onToggleChat?: () => void;
  chatOpen?: boolean;
  guildId: string | null;
}) {
  const v = useVoice();
  const mobile = useIsMobile();
  const react = usePopover();
  const share = usePopover();
  const quality = useSettings((s) => s.screenQuality);
  // Phones: smaller buttons, so the whole row (now with the soundboard) fits the screen.
  const btn = clsx("flex shrink-0 items-center justify-center rounded-2xl transition-all duration-150 active:scale-95", mobile ? "h-10 w-10" : "h-12 w-12");
  const neutral = "bg-raised text-fg hover:bg-overlay";
  return (
    <div className={clsx("pointer-events-none absolute inset-x-0 bottom-0 flex justify-center", compact ? "pb-2" : "pb-5")}>
      <div className={clsx("glass pointer-events-auto flex max-w-[calc(100%-8px)] items-center overflow-x-auto rounded-[22px] p-2 shadow-lift [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", mobile ? "gap-1.5" : "gap-2")}>
        <Tooltip content={v.muted ? t("voice.unmute") : t("voice.mute")}>
          <button onClick={toggleMute} className={clsx(btn, v.muted || v.deafened ? "bg-bad/20 text-bad" : neutral)} aria-label={t("voice.mute")}>
            {v.muted || v.deafened ? <MicOff size={21} /> : <Mic size={21} />}
          </button>
        </Tooltip>
        {!mobile && (
          <Tooltip content={v.deafened ? t("voice.undeafen") : t("voice.deafen")}>
            <button onClick={toggleDeafen} className={clsx(btn, v.deafened ? "bg-bad/20 text-bad" : neutral)} aria-label={t("voice.deafen")}>
              {v.deafened ? <HeadphoneOff size={21} /> : <Headphones size={21} />}
            </button>
          </Tooltip>
        )}
        <Tooltip content={v.cameraOn ? t("voice.cameraOff") : t("voice.camera")}>
          <button onClick={() => void toggleCamera()} className={clsx(btn, v.cameraOn ? "bg-star/25 text-star" : neutral)} aria-label={t("voice.camera")}>
            {v.cameraOn ? <Video size={21} /> : <VideoOff size={21} />}
          </button>
        </Tooltip>
        {v.cameraOn && mobile && (
          <button onClick={() => void flipCamera()} className={clsx(btn, neutral)} aria-label={t("voice.flipCamera")}>
            <SwitchCamera size={21} />
          </button>
        )}
        {canShareScreen() && (
          <div className="flex">
            <Tooltip content={v.screenOn ? t("voice.stopShare") : t("voice.share")}>
              <button onClick={() => void toggleScreen()} className={clsx(btn, !mobile && "rounded-r-md", v.screenOn ? "bg-star/25 text-star" : neutral)} aria-label={t("voice.share")}>
                {v.screenOn ? <MonitorX size={21} /> : <MonitorUp size={21} />}
              </button>
            </Tooltip>
            {!mobile && (
              <button onClick={share.toggle} className={clsx("flex h-12 w-6 items-center justify-center rounded-l-md rounded-r-2xl text-fg-2 transition-colors hover:bg-overlay", neutral)} aria-label={t("voice.shareQuality")}>
                <Settings2 size={14} />
              </button>
            )}
          </div>
        )}
        <Tooltip content={t("voice.reactions")}>
          <button onClick={react.toggle} className={clsx(btn, neutral)} aria-label={t("voice.reactions")}>
            <SmilePlus size={21} />
          </button>
        </Tooltip>
        <SoundboardButton className={clsx(btn, neutral)} />
        {onToggleChat && (
          <Tooltip content={t("voice.chat")}>
            <button onClick={onToggleChat} className={clsx(btn, chatOpen ? "bg-star/25 text-star" : neutral)} aria-label={t("voice.chat")}>
              <MessageSquare size={20} />
            </button>
          </Tooltip>
        )}
        {!mobile && (
          <Tooltip content={fullscreen ? t("voice.exitFullscreen") : t("voice.fullscreen")}>
            <button onClick={onFullscreen} className={clsx(btn, neutral)} aria-label={t("voice.fullscreen")}>
              {fullscreen ? <Minimize2 size={20} /> : <Maximize2 size={20} />}
            </button>
          </Tooltip>
        )}
        {guildId && !mobile && (
          <Tooltip content={t("voice.invite")}>
            <button onClick={() => useUI.getState().setModal({ kind: "invite", guildId, channelId })} className={clsx(btn, neutral)} aria-label={t("voice.invite")}>
              <UserPlus size={20} />
            </button>
          </Tooltip>
        )}
        <Tooltip content={t("voice.disconnect")}>
          <button onClick={() => void leaveVoice()} className={clsx(btn, mobile ? "!w-[52px]" : "!w-16", "bg-bad text-white hover:brightness-110")} aria-label={t("voice.disconnect")}>
            <PhoneOff size={22} />
          </button>
        </Tooltip>
      </div>
      <Popover anchor={react.anchor} onClose={react.close} placement="top">
        <div className="menu-surface flex gap-1 rounded-2xl p-2 shadow-lift">
          {QUICK_REACTIONS.map((e) => (
            <button key={e} onClick={() => sendReaction(e)} className="flex h-11 w-11 items-center justify-center rounded-xl text-[26px] transition-transform hover:scale-125 hover:bg-raised">
              {e}
            </button>
          ))}
        </div>
      </Popover>
      <Popover anchor={share.anchor} onClose={share.close} placement="top">
        <MenuList
          onClose={share.close}
          items={(["720p30", "1080p30", "1080p60", "1440p60", "source"] as const).map((q) => ({
            label: q === "source" ? `${t("voice.qualitySource")} · 60 fps` : q.replace("p", "p · ") + " fps",
            checked: quality === q,
            onSelect: () => settings().setLocal({ screenQuality: q }),
          }))}
        />
      </Popover>
    </div>
  );
}

/** Per-user volume slider (used in the user popout during calls). */
export function UserVolume({ userId }: { userId: string }) {
  const vol = useSettings((s) => s.userVolumes[userId] ?? 100);
  const svol = useSettings((s) => s.streamVolumes[userId] ?? 100);
  const streaming = useData((s) => !!s.voiceStates[userId]?.selfStream);
  const localMuted = useSettings((s) => !!s.localMutes[userId]);
  if (isLocal(userId)) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-[13px] font-semibold text-fg-2">
        <Volume2 size={14} /> {t("voice.volume")}
      </div>
      <Slider value={vol} min={0} max={200} onChange={(v) => settings().setLocal({ userVolumes: { ...settings().userVolumes, [userId]: v } })} format={(v) => `${v}%`} />
      <button
        onClick={() => toggleLocalMute(userId)}
        className={clsx("flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-[13px] font-semibold transition-colors", localMuted ? "bg-bad/15 text-bad hover:bg-bad/25" : "bg-raised text-fg-2 hover:bg-overlay hover:text-fg")}
      >
        {localMuted ? <Volume2 size={14} /> : <VolumeX size={14} />}
        {localMuted ? t("voice.localUnmute") : t("voice.localMute")}
      </button>
      {streaming && (
        <>
          <div className="text-[13px] font-semibold text-fg-2">{t("voice.streamVolume")}</div>
          <Slider value={svol} min={0} max={200} onChange={(v) => settings().setLocal({ streamVolumes: { ...settings().streamVolumes, [userId]: v } })} format={(v) => `${v}%`} />
        </>
      )}
    </div>
  );
}
