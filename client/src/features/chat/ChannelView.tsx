import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import clsx from "clsx";
import { ArrowLeft, Bell, BellOff, Pin, Search, Users, Phone, Video, MessagesSquare, UploadCloud, PhoneOff } from "lucide-react";
import { Permission } from "@nova/shared";
import { t } from "../../lib/i18n";
import { useIsMobile, useTypingUsers } from "../../lib/hooks";
import { can, channelPerms, channelTitle, displayName, dmPartner, isMuted, useData } from "../../store/data";
import { openPanel, useUI } from "../../store/ui";
import { settings, useSettings } from "../../store/settings";
import { touch } from "../../store/messages";
import { IconButton } from "../../components/ui/primitives";
import { useContextMenu } from "../../components/ui/overlay";
import { UserAvatar } from "../../components/ui/avatar";
import { MessageList } from "./MessageList";
import { Composer, dropFiles } from "./Composer";
import { channelIcon } from "../shell/GuildSidebar";
import { channelMenu, setMute, callUser } from "../shell/menus";
import { activityText } from "../people/presence";
import { VoiceStage } from "../voice/VoiceStage";
import { joinVoice, leaveVoice, toggleCamera, useVoice } from "../voice/voice";
import { Markdown } from "./markdown";

function Typing({ channelId }: { channelId: string }) {
  const users = useTypingUsers(channelId);
  const guildId = useData((s) => s.channels[channelId]?.guildId ?? null);
  const names = useData(useShallow((s) => users.map((u) => displayName(s, u, guildId))));
  if (!names.length) return <div className="h-5 shrink-0" />;
  const text =
    names.length === 1 ? t("chat.typing1", { a: names[0] }) : names.length === 2 ? t("chat.typing2", { a: names[0], b: names[1] }) : names.length === 3 ? t("chat.typing3", { a: names[0], b: names[1], c: names[2] }) : t("chat.typingMany");
  return (
    <div className="flex h-5 shrink-0 items-center gap-1.5 px-5 text-[12.5px] text-fg-2">
      <span className="flex items-end gap-[3px] pb-0.5">
        <span className="typing-dot h-1.5 w-1.5 rounded-full bg-fg-2" />
        <span className="typing-dot h-1.5 w-1.5 rounded-full bg-fg-2" />
        <span className="typing-dot h-1.5 w-1.5 rounded-full bg-fg-2" />
      </span>
      <span className="truncate">
        {text}
        <span className="text-fg-3">…</span>
      </span>
    </div>
  );
}

function Header({ channelId }: { channelId: string }) {
  const c = useData((s) => s.channels[channelId]);
  const title = useData((s) => channelTitle(s, c));
  const partner = useData((s) => (c?.type === "dm" ? dmPartner(s, c) : undefined));
  const partnerPresence = useData((s) => (partner ? s.presences[partner.id] : undefined));
  const muted = useData((s) => isMuted(s, channelId, c?.guildId));
  const panel = useUI((s) => s.panel);
  const memberListOpen = useSettings((s) => s.memberListOpen);
  const inCall = useVoice((s) => s.channelId === channelId);
  const mobile = useIsMobile();
  const menu = useContextMenu();
  const [topicOpen, setTopicOpen] = useState(false);
  if (!c) return null;
  const isPrivate = !c.guildId;
  const sub = partner ? activityText(partnerPresence) ?? (partnerPresence ? t(`status.${partnerPresence.status}`) : null) : null;
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line/8 px-3" onContextMenu={(e) => menu(e, channelMenu(channelId))}>
      {mobile && (
        <IconButton label={t("common.back")} onClick={() => useUI.setState({ mobilePane: "nav" })}>
          <ArrowLeft size={20} />
        </IconButton>
      )}
      {partner ? <UserAvatar userId={partner.id} size={26} statusRing="ring-surface" /> : <span className="shrink-0 text-fg-3">{c.type === "group_dm" ? <Users size={20} /> : channelIcon(c, 20)}</span>}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <h1 className="shrink-0 truncate text-[16px] font-semibold">{title}</h1>
        {(c.topic || sub) && !mobile && (
          <>
            <span className="h-5 w-px shrink-0 bg-line/15" />
            <button onClick={() => c.topic && setTopicOpen(!topicOpen)} className={clsx("min-w-0 truncate text-left text-[13.5px] text-fg-3", topicOpen && "whitespace-normal")}>
              {c.topic ? <Markdown content={c.topic} guildId={c.guildId} className="inline" /> : sub}
            </button>
          </>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {isPrivate && (
          <>
            {inCall ? (
              <IconButton label={t("voice.disconnect")} onClick={() => void leaveVoice()} className="!text-bad">
                <PhoneOff size={19} />
              </IconButton>
            ) : (
              <>
                <IconButton label={t("call.start")} onClick={() => (partner ? void callUser(partner.id) : void joinVoice(channelId))}>
                  <Phone size={19} />
                </IconButton>
                <IconButton
                  label={t("call.startVideo")}
                  onClick={async () => {
                    await joinVoice(channelId);
                    await toggleCamera();
                  }}
                >
                  <Video size={20} />
                </IconButton>
              </>
            )}
          </>
        )}
        {c.guildId && c.type !== "voice" && (
          <IconButton label={t("channel.threads")} onClick={() => openPanel("thread")} active={panel === "thread"} className="max-md:hidden">
            <MessagesSquare size={19} />
          </IconButton>
        )}
        <IconButton label={muted ? t("channel.unmute") : t("channel.mute")} onClick={() => void setMute(channelId, !muted)} active={muted}>
          {muted ? <BellOff size={19} /> : <Bell size={19} />}
        </IconButton>
        <IconButton label={t("chat.pinned")} onClick={() => openPanel("pins")} active={panel === "pins"}>
          <Pin size={19} />
        </IconButton>
        {c.guildId && (
          <IconButton
            label={t("common.members")}
            active={panel === "members" || (!panel && memberListOpen)}
            onClick={() => {
              if (mobile || window.innerWidth < 1180) openPanel("members");
              else if (panel) useUI.setState({ panel: null });
              else settings().setLocal({ memberListOpen: !memberListOpen });
            }}
          >
            <Users size={19} />
          </IconButton>
        )}
        <IconButton label={t("common.search")} onClick={() => openPanel("search")} active={panel === "search"}>
          <Search size={19} />
        </IconButton>
      </div>
    </header>
  );
}

export function ChannelView({ channelId }: { channelId: string }) {
  const c = useData((s) => s.channels[channelId]);
  const canView = useData((s) => can(channelPerms(s, channelId), Permission.VIEW_CHANNEL) || !s.channels[channelId]?.guildId);
  const connectedHere = useVoice((s) => s.channelId === channelId);
  const callActive = useData((s) => !!s.calls[channelId]);
  const [drag, setDrag] = useState(0);
  const [showVoiceChat, setShowVoiceChat] = useState(false);
  const mobile = useIsMobile();

  useEffect(() => touch(channelId), [channelId]);

  if (!c) return null;
  if (!canView) return <div className="flex flex-1 items-center justify-center text-fg-3">{t("channel.noAccess")}</div>;

  const isVoice = c.type === "voice";
  const privateCall = !c.guildId && (connectedHere || callActive);

  const chat = (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes("Files")) setDrag((d) => d + 1);
      }}
      onDragLeave={() => setDrag((d) => Math.max(0, d - 1))}
      onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(0);
        if (e.dataTransfer.files.length) dropFiles(channelId, e.dataTransfer.files);
      }}
    >
      <MessageList key={channelId} channelId={channelId} />
      <Typing channelId={channelId} />
      <Composer channelId={channelId} compact={isVoice} />
      {drag > 0 && (
        <div className="pointer-events-none absolute inset-3 z-20 flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-star/70 bg-canvas/80 backdrop-blur-sm anim-fade">
          <UploadCloud size={48} className="text-star" />
          <div className="mt-3 font-display text-[18px] font-semibold">{t("chat.dropFiles")}</div>
          <div className="text-[14px] text-fg-2">{c.guildId ? t("chat.dropFilesTo", { name: c.name }) : ""}</div>
        </div>
      )}
    </div>
  );

  if (isVoice) {
    return (
      <div className="flex min-w-0 flex-1 flex-col">
        <Header channelId={channelId} />
        <div className="flex min-h-0 flex-1">
          <div className={clsx("flex min-h-0 min-w-0 flex-1", mobile && showVoiceChat && "hidden")}>
            <VoiceStage channelId={channelId} onToggleChat={() => setShowVoiceChat((v) => !v)} chatOpen={showVoiceChat} />
          </div>
          {showVoiceChat && <div className={clsx("flex min-h-0 flex-col border-l border-line/8", mobile ? "flex-1" : "w-[380px] shrink-0")}>{chat}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <Header channelId={channelId} />
      {privateCall && (
        <div className="h-[46%] min-h-[240px] shrink-0 border-b border-line/8 bg-canvas/60">
          <VoiceStage channelId={channelId} compact />
        </div>
      )}
      {chat}
    </div>
  );
}

