import { memo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import clsx from "clsx";
import {
  ChevronDown,
  ChevronRight,
  Hash,
  Megaphone,
  Volume2,
  Lock,
  Settings,
  Plus,
  MicOff,
  HeadphoneOff,
  Video,
  CornerDownRight,
  BellOff,
} from "lucide-react";
import { Permission, type ChannelDTO } from "@nova/shared";
import { api } from "../../lib/api";
import { t } from "../../lib/i18n";
import { toast } from "../../lib/bus";
import { useGuildChannels, useThreads } from "../../lib/hooks";
import { mediaUrl } from "../../lib/server";
import { can, channelPerms, displayName, guildPerms, isMuted, isUnread, useData, voiceMembers } from "../../store/data";
import { navigate, useUI } from "../../store/ui";
import { joinVoice, useVoice } from "../voice/voice";
import { RadioLine } from "../voice/RadioPanel";
import { useAura } from "../voice/levels";
import { MenuList, Popover, usePopover, useContextMenu, Tooltip } from "../../components/ui/overlay";
import { UserAvatar } from "../../components/ui/avatar";
import { channelMenu, guildMenu, userMenu } from "./menus";

const COLLAPSE_KEY = "nova.collapsed";
const loadCollapsed = (): Record<string, boolean> => {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "{}");
  } catch {
    return {};
  }
};

export function channelIcon(c: Pick<ChannelDTO, "type">, size = 18) {
  if (c.type === "voice") return <Volume2 size={size} />;
  if (c.type === "announcement") return <Megaphone size={size} />;
  if (c.type === "thread") return <CornerDownRight size={size} />;
  return <Hash size={size} />;
}

function isPrivate(c: ChannelDTO): boolean {
  if (!c.guildId) return false;
  const ev = c.overwrites.find((o) => o.id === c.guildId && o.type === "role");
  return !!ev && (BigInt(ev.deny) & Permission.VIEW_CHANNEL) !== 0n;
}

export function GuildSidebar({ guildId }: { guildId: string }) {
  const guild = useData((s) => s.guilds[guildId]);
  const groups = useGuildChannels(guildId);
  const bits = useData((s) => guildPerms(s, guildId));
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const drag = useRef<{ id: string; type: string } | null>(null);
  const header = usePopover();
  const menu = useContextMenu();
  const manage = can(bits, Permission.MANAGE_CHANNELS);

  const toggle = (id: string) => {
    const next = { ...collapsed, [id]: !collapsed[id] };
    setCollapsed(next);
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
  };

  const drop = async (targetId: string, parentId: string | null) => {
    const src = drag.current;
    drag.current = null;
    if (!src || src.id === targetId || !manage) return;
    const s = useData.getState();
    const siblings = groups
      .find((g) => (g.category?.id ?? null) === parentId)
      ?.channels.filter((c) => c.id !== src.id && (src.type === "voice") === (c.type === "voice")) ?? [];
    const idx = siblings.findIndex((c) => c.id === targetId);
    const moved = s.channels[src.id];
    if (!moved) return;
    siblings.splice(idx < 0 ? siblings.length : idx, 0, moved);
    const items = siblings.map((c, i) => ({ id: c.id, position: i, ...(c.id === src.id ? { parentId } : {}) }));
    try {
      await api(`/api/guilds/${guildId}/channels`, { method: "PATCH", body: items });
    } catch {
      toast(t("errors.unknown"), "error");
    }
  };

  if (!guild) return null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <button
        onClick={header.toggle}
        onContextMenu={(e) => menu(e, guildMenu(guildId))}
        className={clsx("group relative flex shrink-0 items-end overflow-hidden text-left transition-colors", guild.banner ? "h-32" : "h-12 hover:bg-raised/60")}
      >
        {guild.banner && (
          <>
            <img src={mediaUrl(guild.banner, 320)} alt="" className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" />
            <div className="absolute inset-0 bg-gradient-to-b from-transparent via-panel/30 to-panel" />
          </>
        )}
        <div className="relative flex h-12 w-full items-center gap-2 px-4">
          <span className="min-w-0 flex-1 truncate font-display text-[15px] font-semibold tracking-[-0.01em]">{guild.name}</span>
          <ChevronDown size={18} className={clsx("shrink-0 text-fg-2 transition-transform", header.anchor && "rotate-180")} />
        </div>
      </button>
      <Popover anchor={header.anchor} onClose={header.close} placement="bottom">
        <MenuList
          className="w-[224px]"
          onClose={header.close}
          items={guildMenu(guildId, { header: true })}
        />
      </Popover>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-2">
        {groups.map((g) => (
          <div key={g.category?.id ?? "_"} className="mb-1">
            {g.category && (
              <div
                className="group flex items-center pt-4 pb-1"
                onDragOver={(e) => manage && e.preventDefault()}
                onDrop={() => void drop("", g.category!.id)}
                onContextMenu={(e) => menu(e, channelMenu(g.category!.id))}
              >
                <button onClick={() => toggle(g.category!.id)} className="flex min-w-0 flex-1 items-center gap-0.5 text-[12.5px] font-semibold text-fg-3 transition-colors hover:text-fg-2">
                  {collapsed[g.category.id] ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                  <span className="truncate">{g.category.name}</span>
                </button>
                {manage && (
                  <Tooltip content={t("guild.createChannel")}>
                    <button
                      onClick={() => useUI.getState().setModal({ kind: "createChannel", guildId, parentId: g.category!.id })}
                      className="mr-1 rounded p-0.5 text-fg-3 opacity-0 transition-opacity hover:text-fg group-hover:opacity-100 touch-visible"
                      aria-label={t("guild.createChannel")}
                    >
                      <Plus size={16} />
                    </button>
                  </Tooltip>
                )}
              </div>
            )}
            {g.channels.map((c) =>
              collapsed[g.category?.id ?? ""] ? (
                <CollapsedChannel key={c.id} channel={c} />
              ) : (
                <div
                  key={c.id}
                  draggable={manage}
                  onDragStart={() => (drag.current = { id: c.id, type: c.type })}
                  onDragOver={(e) => manage && e.preventDefault()}
                  onDrop={() => void drop(c.id, g.category?.id ?? null)}
                >
                  {c.type === "voice" ? <VoiceChannelRow channel={c} /> : <TextChannelRow channel={c} />}
                </div>
              )
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Collapsed categories still show the active channel and anything unread. */
function CollapsedChannel({ channel }: { channel: ChannelDTO }) {
  const active = useUI((s) => s.channelId === channel.id);
  const unread = useData((s) => isUnread(s, channel.id) && !isMuted(s, channel.id, channel.guildId));
  const hasVoice = useData((s) => channel.type === "voice" && voiceMembers(s, channel.id).length > 0);
  if (!active && !unread && !hasVoice) return null;
  return channel.type === "voice" ? <VoiceChannelRow channel={channel} /> : <TextChannelRow channel={channel} />;
}

const TextChannelRow = memo(function TextChannelRow({ channel }: { channel: ChannelDTO }) {
  const active = useUI((s) => s.channelId === channel.id);
  const muted = useData((s) => isMuted(s, channel.id, channel.guildId));
  const unread = useData((s) => isUnread(s, channel.id)) && !muted;
  const mentions = useData((s) => s.readStates[channel.id]?.mentionCount ?? 0);
  const manage = useData((s) => can(channelPerms(s, channel.id), Permission.MANAGE_CHANNELS));
  const threads = useThreads(channel.id);
  const menu = useContextMenu();
  return (
    <>
      <div
        className={clsx(
          "group relative my-px flex h-9 items-center gap-1.5 rounded-lg px-2 transition-colors",
          active ? "bg-raised text-fg" : unread ? "text-fg hover:bg-raised/60" : "text-fg-3 hover:bg-raised/50 hover:text-fg-2",
          muted && !active && "opacity-50"
        )}
        onContextMenu={(e) => menu(e, channelMenu(channel.id))}
      >
        {unread && !active && <span className="absolute -left-2 h-2 w-1 rounded-r-full bg-fg" />}
        <button onClick={() => navigate(channel.guildId!, channel.id)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <span className={clsx("relative shrink-0", active ? "text-star" : "opacity-70")}>
            {channelIcon(channel)}
            {isPrivate(channel) && <Lock size={9} strokeWidth={3} className="absolute -bottom-0.5 -right-1 rounded-sm bg-panel" />}
          </span>
          <span className={clsx("truncate text-[15px]", (unread || active) && "font-semibold")}>{channel.name}</span>
        </button>
        {muted && <BellOff size={14} className="shrink-0 opacity-60" />}
        {mentions > 0 && <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-bad px-1 text-[11px] font-bold text-white">{mentions}</span>}
        {manage && (
          <button
            onClick={() => useUI.getState().setModal({ kind: "channelSettings", channelId: channel.id })}
            aria-label={t("channel.settings")}
            className={clsx("shrink-0 rounded p-0.5 text-fg-3 transition-opacity hover:text-fg touch-visible", active ? "opacity-100" : "opacity-0 group-hover:opacity-100")}
          >
            <Settings size={14} />
          </button>
        )}
      </div>
      {threads.slice(0, 5).map((th) => (
        <ThreadRow key={th.id} thread={th} />
      ))}
    </>
  );
});

function ThreadRow({ thread }: { thread: ChannelDTO }) {
  const active = useUI((s) => s.channelId === thread.id || s.threadId === thread.id);
  const unread = useData((s) => isUnread(s, thread.id));
  return (
    <button
      onClick={() => useUI.setState({ threadId: thread.id, panel: "thread" })}
      className={clsx("my-px ml-5 flex h-8 w-[calc(100%-1.25rem)] items-center gap-1.5 rounded-lg px-2 text-left text-[14px] transition-colors", active ? "bg-raised text-fg" : unread ? "text-fg" : "text-fg-3 hover:bg-raised/50 hover:text-fg-2")}
    >
      <CornerDownRight size={14} className="shrink-0 opacity-60" />
      <span className={clsx("truncate", unread && "font-semibold")}>{thread.name}</span>
    </button>
  );
}

const VoiceChannelRow = memo(function VoiceChannelRow({ channel }: { channel: ChannelDTO }) {
  const members = useData(useShallow((s) => voiceMembers(s, channel.id)));
  const myChannel = useVoice((s) => s.channelId);
  const connected = myChannel === channel.id;
  const viewing = useUI((s) => s.channelId === channel.id);
  const manage = useData((s) => can(channelPerms(s, channel.id), Permission.MANAGE_CHANNELS));
  const menu = useContextMenu();
  const full = channel.userLimit > 0 && members.length >= channel.userLimit && !connected;
  const click = () => {
    navigate(channel.guildId!, channel.id);
    if (!connected && !full) void joinVoice(channel.id);
  };
  return (
    <div className="my-px" onContextMenu={(e) => menu(e, channelMenu(channel.id))}>
      <div className={clsx("group relative flex h-9 items-center gap-1.5 rounded-lg px-2 transition-colors", viewing ? "bg-raised text-fg" : connected ? "text-fg" : "text-fg-3 hover:bg-raised/50 hover:text-fg-2")}>
        <button onClick={click} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <span className={clsx("relative shrink-0", connected ? "text-ok" : "opacity-70")}>
            {channelIcon(channel)}
            {isPrivate(channel) && <Lock size={9} strokeWidth={3} className="absolute -bottom-0.5 -right-1 rounded-sm bg-panel" />}
          </span>
          <span className={clsx("truncate text-[15px]", connected && "font-semibold")}>{channel.name}</span>
        </button>
        {channel.userLimit > 0 && (
          <span className="shrink-0 rounded-md bg-canvas/80 px-1.5 text-[11px] tabular-nums text-fg-3">
            {String(members.length).padStart(2, "0")}/{String(channel.userLimit).padStart(2, "0")}
          </span>
        )}
        {manage && (
          <button
            onClick={() => useUI.getState().setModal({ kind: "channelSettings", channelId: channel.id })}
            aria-label={t("channel.settings")}
            className="shrink-0 rounded p-0.5 text-fg-3 opacity-0 transition-opacity hover:text-fg group-hover:opacity-100 touch-visible"
          >
            <Settings size={14} />
          </button>
        )}
      </div>
      <RadioLine channelId={channel.id} />
      {members.length > 0 && (
        <div className="mb-1 ml-6 mt-0.5 flex flex-col">
          {members.map((v) => (
            <VoiceMember key={v.userId} userId={v.userId} guildId={channel.guildId} />
          ))}
        </div>
      )}
    </div>
  );
});

function VoiceMember({ userId, guildId }: { userId: string; guildId: string | null }) {
  const vs = useData((s) => s.voiceStates[userId]);
  const name = useData((s) => displayName(s, userId, guildId));
  const me = useData((s) => s.me?.id === userId);
  const inMyCall = useVoice((s) => !!s.channelId && s.channelId === vs?.channelId);
  const ref = useRef<HTMLDivElement>(null);
  useAura(ref, userId, me, inMyCall);
  const menu = useContextMenu();
  if (!vs) return null;
  return (
    <button
      onContextMenu={(e) => menu(e, userMenu(userId, guildId))}
      onClick={() => useUI.getState().setModal({ kind: "profile", userId, guildId })}
      className="group flex h-8 items-center gap-2 rounded-lg px-1.5 text-left text-fg-3 transition-colors hover:bg-raised/50 hover:text-fg-2"
    >
      <div ref={ref} className="aura rounded-full" data-speaking="false">
        <UserAvatar userId={userId} size={24} showStatus={false} />
      </div>
      <span className="min-w-0 flex-1 truncate text-[14px]">{name}</span>
      <span className="flex shrink-0 items-center gap-1 text-fg-3">
        {vs.selfStream && <span className="rounded bg-bad px-1 text-[10px] font-bold leading-4 text-white">{t("voice.live")}</span>}
        {vs.selfVideo && <Video size={14} />}
        {(vs.selfMute || vs.serverMute) && <MicOff size={14} className={clsx(vs.serverMute && "text-bad")} />}
        {(vs.selfDeaf || vs.serverDeaf) && <HeadphoneOff size={14} className={clsx(vs.serverDeaf && "text-bad")} />}
      </span>
    </button>
  );
}


