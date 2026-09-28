import { memo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import clsx from "clsx";
import { Plus, Volume2 } from "lucide-react";
import { useData, guildUnread, dmBadgeCount, pendingFriendRequests, privateChannels, isMuted, channelTitle, dmPartner } from "../../store/data";
import { navigate, useUI } from "../../store/ui";
import { settings, useSettings } from "../../store/settings";
import { useVoice } from "../voice/voice";
import { t } from "../../lib/i18n";
import { NovaStar } from "../../components/Logo";
import { Tooltip, useContextMenu } from "../../components/ui/overlay";
import { GuildIcon, UserAvatar, Avatar } from "../../components/ui/avatar";
import { guildMenu } from "./menus";
import { selectFirstTextChannel } from "../../lib/hooks";

function Pill({ state }: { state: "none" | "unread" | "hover" | "active" }) {
  const h = state === "active" ? 36 : state === "hover" ? 18 : state === "unread" ? 8 : 0;
  return (
    <span
      className="absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-fg transition-[height,background-color] duration-200 ease-[cubic-bezier(.3,1.3,.5,1)]"
      style={{ height: h, background: state === "active" ? "rgb(var(--star))" : undefined, boxShadow: state === "active" ? "0 0 12px rgb(var(--star) / 0.8)" : undefined }}
    />
  );
}

function Badge({ n }: { n: number }) {
  if (!n) return null;
  return (
    <span className="absolute -bottom-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-bad px-1.5 text-[11px] font-bold text-white ring-[3px] ring-canvas">
      {n > 99 ? "99+" : n}
    </span>
  );
}

const GuildButton = memo(function GuildButton({ guildId, onDragStart, onDrop }: { guildId: string; onDragStart: () => void; onDrop: () => void }) {
  const guild = useData((s) => s.guilds[guildId]);
  const { unread, mentions } = useData(useShallow((s) => guildUnread(s, guildId)));
  const active = useUI((s) => s.guildId === guildId);
  const voiceChannelId = useVoice((s) => s.channelId);
  const inVoiceHere = useData((s) => !!voiceChannelId && s.channels[voiceChannelId]?.guildId === guildId);
  const [hover, setHover] = useState(false);
  const [dropHint, setDropHint] = useState(false);
  const menu = useContextMenu();
  if (!guild) return null;
  const open = () => {
    const last = settings().lastChannels[guildId];
    const s = useData.getState();
    navigate(guildId, last && s.channels[last] ? last : selectFirstTextChannel(s, guildId));
  };
  return (
    <div className={clsx("relative flex w-full justify-center py-1", dropHint && "before:absolute before:inset-x-3 before:-top-0.5 before:h-0.5 before:rounded-full before:bg-star")}>
      <Pill state={active ? "active" : hover ? "hover" : unread ? "unread" : "none"} />
      <Tooltip content={guild.name} placement="right">
        <button
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move";
            onDragStart();
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDropHint(true);
          }}
          onDragLeave={() => setDropHint(false)}
          onDrop={() => {
            setDropHint(false);
            onDrop();
          }}
          onClick={open}
          onContextMenu={(e) => menu(e, guildMenu(guildId))}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          aria-label={guild.name}
          className="group relative transition-transform duration-150 active:translate-y-px"
        >
          <GuildIcon guildId={guild.id} name={guild.name} icon={guild.icon} active={active} className={clsx(active && "shadow-star")} />
          <Badge n={mentions} />
          {inVoiceHere && (
            <span className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-ok text-[#04150d] ring-[3px] ring-canvas">
              <Volume2 size={11} strokeWidth={3} />
            </span>
          )}
        </button>
      </Tooltip>
    </div>
  );
});

function UnreadDms() {
  const list = useData(useShallow((s) => privateChannels(s).filter((c) => (s.readStates[c.id]?.mentionCount ?? 0) > 0 && !isMuted(s, c.id)).slice(0, 5)));
  return (
    <>
      {list.map((c) => (
        <UnreadDm key={c.id} channelId={c.id} />
      ))}
    </>
  );
}

function UnreadDm({ channelId }: { channelId: string }) {
  const c = useData((s) => s.channels[channelId]);
  const partner = useData((s) => (c ? dmPartner(s, c) : undefined));
  const title = useData((s) => channelTitle(s, c));
  const n = useData((s) => s.readStates[channelId]?.mentionCount ?? 0);
  if (!c) return null;
  return (
    <div className="relative flex justify-center py-1 anim-pop">
      <Pill state="unread" />
      <Tooltip content={title} placement="right">
        <button onClick={() => navigate("@me", c.id)} className="relative" aria-label={title}>
          {c.type === "dm" && partner ? <UserAvatar userId={partner.id} size={48} showStatus={false} /> : <Avatar name={title} userId={c.id} src={c.icon} size={48} />}
          <Badge n={n} />
        </button>
      </Tooltip>
    </div>
  );
}

export function ServerRail() {
  const guildIds = useData((s) => s.guildIds);
  const isHome = useUI((s) => s.guildId === "@me");
  const homeBadge = useData((s) => dmBadgeCount(s) + pendingFriendRequests(s));
  const [dragging, setDragging] = useState<string | null>(null);
  const [hoverHome, setHoverHome] = useState(false);

  const reorder = (target: string) => {
    if (!dragging || dragging === target) return;
    const ids = guildIds.filter((g) => g !== dragging);
    ids.splice(ids.indexOf(target), 0, dragging);
    useData.setState({ guildIds: ids });
    settings().setSynced({ guildOrder: ids });
    setDragging(null);
  };
  useSettings((s) => s.guildOrder); // re-render on remote order changes

  return (
    <nav className="scroll-thin flex w-[72px] shrink-0 flex-col items-center overflow-y-auto overflow-x-hidden pb-3 pt-2" aria-label={t("nav.servers")}>
      <div className="relative flex w-full justify-center py-1">
        <Pill state={isHome ? "active" : hoverHome ? "hover" : "none"} />
        <Tooltip content={t("nav.home")} placement="right">
          <button
            onClick={() => navigate("@me", useSettings.getState().lastChannels["@me"] ?? null)}
            onMouseEnter={() => setHoverHome(true)}
            onMouseLeave={() => setHoverHome(false)}
            aria-label={t("nav.home")}
            className={clsx(
              "group relative flex h-12 w-12 items-center justify-center transition-all duration-200",
              isHome ? "rounded-[32%] bg-star/18 shadow-star" : "rounded-[50%] bg-raised hover:rounded-[32%] hover:bg-star/15"
            )}
          >
            <NovaStar size={26} />
            <Badge n={homeBadge} />
          </button>
        </Tooltip>
      </div>
      <UnreadDms />
      <div className="mx-auto my-1.5 h-0.5 w-8 rounded-full bg-line/15" />
      {guildIds.map((id) => (
        <GuildButton key={id} guildId={id} onDragStart={() => setDragging(id)} onDrop={() => reorder(id)} />
      ))}
      <div className="relative flex w-full justify-center py-1">
        <Tooltip content={t("nav.addServer")} placement="right">
          <button
            onClick={() => useUI.getState().setModal({ kind: "createGuild" })}
            aria-label={t("nav.addServer")}
            className="flex h-12 w-12 items-center justify-center rounded-[50%] bg-raised text-ok transition-all duration-200 hover:rounded-[32%] hover:bg-ok hover:text-[#04150d]"
          >
            <Plus size={24} />
          </button>
        </Tooltip>
      </div>
    </nav>
  );
}
