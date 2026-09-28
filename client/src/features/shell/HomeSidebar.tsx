import { memo } from "react";
import { useShallow } from "zustand/react/shallow";
import clsx from "clsx";
import { AtSign, Bookmark, Plus, Search, Users, X } from "lucide-react";
import { RelationshipType } from "@nova/shared";
import { api } from "../../lib/api";
import { t } from "../../lib/i18n";
import { channelTitle, dmPartner, isMuted, isUnread, pendingFriendRequests, privateChannels, useData } from "../../store/data";
import { navigate, openPanel, useUI } from "../../store/ui";
import { Avatar, UserAvatar } from "../../components/ui/avatar";
import { Tooltip, useContextMenu } from "../../components/ui/overlay";
import { channelMenu, userMenu } from "./menus";
import { useVoice } from "../voice/voice";
import { activityText } from "../people/presence";

export function HomeSidebar() {
  const channels = useData(useShallow((s) => privateChannels(s)));
  const pending = useData(pendingFriendRequests);
  const onFriends = useUI((s) => s.guildId === "@me" && !s.channelId);
  const panel = useUI((s) => s.panel);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center px-2.5">
        <button onClick={() => useUI.setState({ switcher: true })} className="flex h-8 w-full items-center gap-2 rounded-lg bg-canvas/70 px-2.5 text-[13.5px] text-fg-3 ring-1 ring-line/10 transition-colors hover:text-fg-2">
          <Search size={15} />
          {t("nav.findChat")}
        </button>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-1">
        <NavItem icon={<Users size={20} />} label={t("nav.friends")} active={onFriends} badge={pending} onClick={() => navigate("@me")} />
        <NavItem icon={<AtSign size={20} />} label={t("nav.inbox")} active={panel === "inbox"} onClick={() => openPanel("inbox")} />
        <NavItem icon={<Bookmark size={20} />} label={t("nav.bookmarks")} active={panel === "bookmarks"} onClick={() => openPanel("bookmarks")} />
        <div className="flex items-center justify-between px-2 pb-1.5 pt-5">
          <span className="text-[12.5px] font-semibold text-fg-3">{t("nav.directMessages")}</span>
          <Tooltip content={t("nav.newDm")}>
            <button onClick={() => useUI.getState().setModal({ kind: "newDm" })} className="rounded p-0.5 text-fg-3 hover:text-fg" aria-label={t("nav.newDm")}>
              <Plus size={16} />
            </button>
          </Tooltip>
        </div>
        {channels.map((c) => (
          <DmRow key={c.id} channelId={c.id} />
        ))}
      </div>
    </div>
  );
}

function NavItem({ icon, label, active, badge, onClick }: { icon: React.ReactNode; label: string; active?: boolean; badge?: number; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={clsx("my-px flex h-11 w-full items-center gap-3 rounded-lg px-2.5 text-[15px] font-medium transition-colors", active ? "bg-raised text-fg" : "text-fg-2 hover:bg-raised/50 hover:text-fg")}
    >
      <span className={clsx(active && "text-star")}>{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {!!badge && <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-bad px-1.5 text-[11px] font-bold text-white">{badge}</span>}
    </button>
  );
}

const DmRow = memo(function DmRow({ channelId }: { channelId: string }) {
  const c = useData((s) => s.channels[channelId]);
  const partner = useData((s) => (c?.type === "dm" ? dmPartner(s, c) : undefined));
  const title = useData((s) => channelTitle(s, c));
  const active = useUI((s) => s.channelId === channelId);
  const muted = useData((s) => isMuted(s, channelId));
  const unread = useData((s) => isUnread(s, channelId)) && !muted;
  const mentions = useData((s) => s.readStates[channelId]?.mentionCount ?? 0);
  const presence = useData((s) => (partner ? s.presences[partner.id] : undefined));
  const blocked = useData((s) => (partner ? s.relationships[partner.id]?.type === RelationshipType.BLOCKED : false));
  const inCall = useData((s) => !!s.calls[channelId]);
  const myCall = useVoice((s) => s.channelId === channelId);
  const menu = useContextMenu();
  if (!c) return null;
  const sub = c.type === "group_dm" ? t("guild.memberCount", { n: c.recipients.length }) : presence ? activityText(presence) : null;
  return (
    <div
      className={clsx("group my-px flex h-[46px] items-center gap-2.5 rounded-lg px-2 transition-colors", active ? "bg-raised text-fg" : unread ? "text-fg hover:bg-raised/60" : "text-fg-3 hover:bg-raised/50 hover:text-fg-2", blocked && "opacity-50")}
      onContextMenu={(e) => menu(e, partner ? [...userMenu(partner.id), { separator: true }, ...channelMenu(channelId)] : channelMenu(channelId))}
    >
      <button onClick={() => navigate("@me", channelId)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
        {partner ? <UserAvatar userId={partner.id} size={32} statusRing={active ? "ring-raised" : "ring-panel"} /> : <Avatar name={title} userId={c.id} src={c.icon} size={32} />}
        <div className="min-w-0 flex-1">
          <div className={clsx("truncate text-[15px] leading-tight", (unread || active) && "font-semibold")}>{title}</div>
          {sub && <div className="truncate text-[12px] leading-tight text-fg-3">{sub}</div>}
        </div>
      </button>
      {(inCall || myCall) && <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-ok" />}
      {mentions > 0 ? (
        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-bad px-1.5 text-[11px] font-bold text-white">{mentions}</span>
      ) : (
        <button
          aria-label={t("common.close")}
          onClick={() => {
            void api(`/api/channels/${channelId}`, { method: "DELETE" });
            if (active) navigate("@me");
          }}
          className="shrink-0 rounded p-0.5 text-fg-3 opacity-0 hover:text-fg group-hover:opacity-100 touch-visible"
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
});
