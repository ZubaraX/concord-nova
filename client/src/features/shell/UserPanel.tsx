import { useEffect, useState } from "react";
import clsx from "clsx";
import { Headphones, HeadphoneOff, Mic, MicOff, Settings, PhoneOff, Video, VideoOff, MonitorUp, MonitorX, Signal, AudioLines } from "lucide-react";
import { api } from "../../lib/api";
import { t } from "../../lib/i18n";
import { fmtClock } from "../../lib/time";
import { canShareScreen } from "../../lib/platform";
import { channelTitle, useData } from "../../store/data";
import { navigate, useUI } from "../../store/ui";
import { useSettings } from "../../store/settings";
import { IconButton } from "../../components/ui/primitives";
import { MenuList, Popover, Tooltip, usePopover } from "../../components/ui/overlay";
import { UserAvatar, StatusDot } from "../../components/ui/avatar";
import { leaveVoice, toggleCamera, toggleDeafen, toggleMute, toggleScreen, useVoice, type Quality } from "../voice/voice";
import type { ChosenStatus } from "@nova/shared";

const QUALITY_COLOR: Record<Quality, string> = { excellent: "text-ok", good: "text-ok", poor: "text-warn", lost: "text-bad", unknown: "text-fg-3" };

function CallTimer({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="tabular-nums">{fmtClock((now - since) / 1000)}</span>;
}

export function VoicePanel() {
  const v = useVoice();
  const channel = useData((s) => (v.channelId ? s.channels[v.channelId] : undefined));
  const title = useData((s) => channelTitle(s, channel));
  const guildName = useData((s) => (channel?.guildId ? s.guilds[channel.guildId]?.name : null));
  const me = useData((s) => s.me?.id);
  if (!v.channelId || !channel) return null;
  const q = (me && v.quality[me]) || "unknown";
  const label = v.state === "connected" ? t("voice.connected") : v.state === "reconnecting" ? t("voice.reconnecting") : v.state === "failed" ? t("voice.failed") : t("voice.connecting");
  return (
    <div className="border-b border-line/10 px-2.5 pb-2 pt-2.5">
      <div className="flex items-center gap-2">
        <Tooltip content={`${t("voice.quality")}: ${q}`}>
          <Signal size={18} className={clsx("shrink-0", v.state === "connected" ? QUALITY_COLOR[q] : "text-warn")} />
        </Tooltip>
        <button onClick={() => navigate(channel.guildId ?? "@me", channel.id)} className="min-w-0 flex-1 text-left">
          <div className={clsx("text-[13.5px] font-semibold leading-tight", v.state === "connected" ? "text-ok" : "text-warn")}>{label}</div>
          <div className="truncate text-[12px] leading-tight text-fg-3 hover:underline">
            {title}
            {guildName ? ` / ${guildName}` : ""}
            {v.joinedAt && v.state === "connected" && (
              <>
                {" · "}
                <CallTimer since={v.joinedAt} />
              </>
            )}
          </div>
        </button>
        <IconButton label={t("voice.disconnect")} onClick={() => void leaveVoice()} className="hover:!bg-bad/15 hover:!text-bad">
          <PhoneOff size={18} />
        </IconButton>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1.5">
        <button onClick={() => void toggleCamera()} className={clsx("flex h-8 items-center justify-center rounded-lg transition-colors", v.cameraOn ? "bg-star/20 text-star" : "bg-raised text-fg-2 hover:bg-overlay hover:text-fg")} aria-label={v.cameraOn ? t("voice.cameraOff") : t("voice.camera")}>
          {v.cameraOn ? <VideoOff size={17} /> : <Video size={17} />}
        </button>
        <button
          disabled={!canShareScreen()}
          onClick={() => void toggleScreen()}
          className={clsx("flex h-8 items-center justify-center rounded-lg transition-colors disabled:opacity-40", v.screenOn ? "bg-star/20 text-star" : "bg-raised text-fg-2 hover:bg-overlay hover:text-fg")}
          aria-label={v.screenOn ? t("voice.stopShare") : t("voice.share")}
        >
          {v.screenOn ? <MonitorX size={17} /> : <MonitorUp size={17} />}
        </button>
        <NoiseToggle />
      </div>
    </div>
  );
}

function NoiseToggle() {
  const noise = useSettings((s) => s.noise);
  const on = noise === "rnnoise";
  return (
    <Tooltip content={`${t("settings.noiseSuppression")}: ${on ? t("settings.noiseAi") : noise === "standard" ? t("settings.noiseStandard") : t("settings.noiseOff")}`}>
      <button
        onClick={() => useSettings.getState().setLocal({ noise: on ? "standard" : "rnnoise" })}
        className={clsx("flex h-8 w-full items-center justify-center rounded-lg transition-colors", on ? "bg-star/20 text-star" : "bg-raised text-fg-2 hover:bg-overlay hover:text-fg")}
        aria-label={t("settings.noiseSuppression")}
      >
        <AudioLines size={17} />
      </button>
    </Tooltip>
  );
}

const STATUSES: ChosenStatus[] = ["online", "idle", "dnd", "invisible"];

export function UserPanel() {
  const me = useData((s) => s.me);
  const presence = useData((s) => (s.me ? s.presences[s.me.id] : undefined));
  const muted = useVoice((s) => s.muted);
  const deafened = useVoice((s) => s.deafened);
  const talkingMuted = useVoice((s) => s.talkingWhileMuted);
  const pop = usePopover();
  if (!me) return null;
  const setStatus = (status: ChosenStatus) => void api("/api/users/@me/status", { method: "PATCH", body: { status } });
  const sub = me.customStatus?.text || me.customStatus?.emoji ? [me.customStatus.emoji, me.customStatus.text].filter(Boolean).join(" ") : `@${me.username}`;
  return (
    <div className="shrink-0 bg-canvas/40">
      <VoicePanel />
      <div className="flex items-center gap-1 p-2">
        <button onClick={pop.toggle} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg p-1 text-left transition-colors hover:bg-raised">
          <UserAvatar userId={me.id} size={34} statusRing="ring-panel" />
          <div className="min-w-0">
            <div className="truncate text-[14px] font-semibold leading-tight">{me.displayName || me.username}</div>
            <div className="truncate text-[12px] leading-tight text-fg-3">{presence?.activities[0] ? t(`status.${presence.activities[0].type}`, { name: presence.activities[0].name }) : sub}</div>
          </div>
        </button>
        <div className="relative">
          <IconButton label={muted || deafened ? t("voice.unmute") : t("voice.mute")} active={false} onClick={toggleMute} className={clsx((muted || deafened) && "!text-bad")}>
            {muted || deafened ? <MicOff size={19} /> : <Mic size={19} />}
          </IconButton>
          {talkingMuted && (
            <span className="pointer-events-none absolute -top-9 right-0 whitespace-nowrap rounded-lg bg-bad px-2 py-1 text-[12px] font-semibold text-white shadow-lift anim-pop">{t("voice.micTalkingMuted")}</span>
          )}
        </div>
        <IconButton label={deafened ? t("voice.undeafen") : t("voice.deafen")} onClick={toggleDeafen} className={clsx(deafened && "!text-bad")}>
          {deafened ? <HeadphoneOff size={19} /> : <Headphones size={19} />}
        </IconButton>
        <IconButton label={t("settings.title")} onClick={() => useUI.getState().setModal({ kind: "userSettings" })}>
          <Settings size={19} />
        </IconButton>
      </div>
      <Popover anchor={pop.anchor} onClose={pop.close} placement="top-start">
        <MenuList
          className="w-[250px]"
          onClose={pop.close}
          items={[
            ...STATUSES.map((st) => ({
              label: (
                <span className="flex flex-col">
                  <span>{t(`status.${st}`)}</span>
                  {st === "dnd" && <span className="text-[11.5px] opacity-70">{t("status.dndHint")}</span>}
                  {st === "invisible" && <span className="text-[11.5px] opacity-70">{t("status.invisibleHint")}</span>}
                </span>
              ),
              icon: <StatusDot status={st === "invisible" ? "offline" : st} size={10} ring="ring-transparent" />,
              checked: me.status === st,
              onSelect: () => setStatus(st),
            })),
            { separator: true },
            { label: t("status.custom"), onSelect: () => useUI.getState().setModal({ kind: "status" }) },
            { label: t("profile.editProfile"), onSelect: () => useUI.getState().setModal({ kind: "userSettings", tab: "profile" }) },
          ]}
        />
      </Popover>
    </div>
  );
}
