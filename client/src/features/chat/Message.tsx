import { memo, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import {
  Reply,
  SmilePlus,
  Pencil,
  MoreHorizontal,
  Trash2,
  Pin,
  PinOff,
  Copy,
  Link2,
  EyeOff,
  Bookmark,
  MessagesSquare,
  UserPlus,
  PhoneCall,
  PhoneMissed,
  CornerUpRight,
  BarChart3,
  AlertCircle,
  Hash,
} from "lucide-react";
import { MessageFlags, MessageType, Permission, RelationshipType, type MessageDTO } from "@nova/shared";
import { api } from "../../lib/api";
import { webLink } from "../../lib/server";
import { errorText, t } from "../../lib/i18n";
import { toast } from "../../lib/bus";
import { fmtDateTime, fmtDuration, fmtMessageTime, fmtTime } from "../../lib/time";
import { isTouch } from "../../lib/platform";
import { can, channelPerms, data, displayName, roleColor, useData } from "../../store/data";
import { discardPending, jumpTo, PENDING_PREFIX, retrySend, useMessages } from "../../store/messages";
import { confirmDialog, useUI } from "../../store/ui";
import { settings, useSettings } from "../../store/settings";
import { Popover, Tooltip, useContextMenu, useLongPress, usePopover, type MenuEntry } from "../../components/ui/overlay";
import { UserAvatar } from "../../components/ui/avatar";
import { Markdown, toPlain } from "./markdown";
import { Attachments, Embeds, Poll, Reactions, ThreadChip, toggleReaction, ReactionEmoji } from "./MessageParts";
import { EmojiPicker } from "./EmojiPicker";
import { tokensToText, textToTokens } from "./mentionText";
import { joinVoice, useVoice } from "../voice/voice";

const QUICK = ["👍", "❤️", "😂"];

export interface RowProps {
  m: MessageDTO;
  grouped: boolean;
  me: string;
  highlight?: boolean;
}

function useMentionsMe(m: MessageDTO, me: string) {
  return useData((s) => {
    if (m.author.id === me) return false;
    if (m.mentions.includes(me) || m.mentionEveryone) return true;
    if (m.guildId && m.mentionRoles.length) {
      const mine = s.members[m.guildId]?.[me]?.roles ?? [];
      return m.mentionRoles.some((r) => mine.includes(r));
    }
    return false;
  });
}

function AuthorName({ m, onClick }: { m: MessageDTO; onClick?: (e: React.MouseEvent) => void }) {
  const name = useData((s) => displayName(s, m.author.id, m.guildId));
  const color = useData((s) => roleColor(s, m.guildId, m.author.id));
  return (
    <button onClick={onClick} className="truncate text-[15px] font-semibold leading-tight hover:underline" style={color ? { color } : undefined}>
      {name}
    </button>
  );
}

function ReplyPreview({ m }: { m: MessageDTO }) {
  const r = m.replyTo!;
  const name = useData((s) => (r.author ? displayName(s, r.author.id, m.guildId) : ""));
  const color = useData((s) => (r.author ? roleColor(s, m.guildId, r.author.id) : undefined));
  const text = useData((s) => toPlain(r.content, { user: (id) => displayName(s, id, m.guildId), role: (id) => (m.guildId ? s.roles[m.guildId]?.[id]?.name ?? "" : ""), channel: (id) => s.channels[id]?.name ?? "" }));
  return (
    <div className="relative mb-0.5 flex min-w-0 items-center gap-1.5 pl-[52px] text-[13px] text-fg-3">
      <span className="absolute left-[18px] top-[9px] h-3 w-[30px] rounded-tl-md border-l-2 border-t-2 border-fg-3/40" />
      {r.deleted ? (
        <span className="italic">{t("chat.originalDeleted")}</span>
      ) : (
        <button onClick={() => void jumpTo(m.channelId, r.id)} className="flex min-w-0 items-center gap-1.5 hover:text-fg-2">
          {r.author && <UserAvatar userId={r.author.id} size={16} showStatus={false} />}
          <span className="shrink-0 font-semibold" style={color ? { color } : undefined}>
            {name}
          </span>
          <span className="truncate">{text || (r.attachments ? t("chat.clickToSee") : "")}</span>
        </button>
      )}
    </div>
  );
}

function SystemRow({ m }: { m: MessageDTO }) {
  const name = useData((s) => displayName(s, m.author.id, m.guildId));
  const time = fmtMessageTime(m.createdAt);
  const inCall = useData((s) => !!s.calls[m.channelId]);
  const joined = useVoice((s) => s.channelId === m.channelId);
  let icon = <UserPlus size={16} className="text-ok" />;
  let body: React.ReactNode = null;
  switch (m.type) {
    case MessageType.GUILD_MEMBER_JOIN: {
      const variants = t("chat.system.joinVariants").split("|");
      const v = variants[parseInt(m.id.slice(-2), 32) % variants.length] ?? t("chat.system.join");
      body = v.replace("{name}", name);
      break;
    }
    case MessageType.CHANNEL_PINNED_MESSAGE:
      icon = <Pin size={16} className="text-fg-2" />;
      body = (
        <>
          {t("chat.system.pin", { name })}{" "}
          {m.replyTo && (
            <button className="font-semibold text-fg hover:underline" onClick={() => void jumpTo(m.channelId, m.replyTo!.id)}>
              {t("chat.jump")}
            </button>
          )}
        </>
      );
      break;
    case MessageType.CALL: {
      const meta = (m.meta ?? {}) as { endedAt?: string | null; durationSec?: number; missed?: boolean };
      const ongoing = !meta.endedAt;
      icon = meta.missed ? <PhoneMissed size={16} className="text-bad" /> : <PhoneCall size={16} className="text-ok" />;
      body = ongoing ? (
        <>
          {t("chat.system.callStarted", { name })}
          {inCall && !joined && (
            <button onClick={() => void joinVoice(m.channelId)} className="ml-2 rounded-lg bg-ok px-2.5 py-0.5 text-[13px] font-semibold text-[#04150d]">
              {t("chat.system.joinCall")}
            </button>
          )}
        </>
      ) : meta.missed ? (
        t("chat.system.callMissed", { name })
      ) : (
        t("chat.system.callEnded", { d: fmtDuration(meta.durationSec ?? 0) })
      );
      break;
    }
    case MessageType.THREAD_CREATED:
      icon = <MessagesSquare size={16} className="text-star" />;
      body = (
        <button onClick={() => useUI.setState({ threadId: String((m.meta as { threadId?: string })?.threadId ?? ""), panel: "thread" })} className="hover:underline">
          {t("chat.system.threadCreated", { name, thread: m.content })}
        </button>
      );
      break;
    case MessageType.POLL_RESULT:
      icon = <BarChart3 size={16} className="text-star" />;
      body = (
        <>
          {t("chat.system.pollEnded", { name })}{" "}
          {m.replyTo && (
            <button className="font-semibold text-fg hover:underline" onClick={() => void jumpTo(m.channelId, m.replyTo!.id)}>
              {t("chat.jump")}
            </button>
          )}
        </>
      );
      break;
    default:
      body = m.content;
  }
  return (
    <div className="group/msg flex items-center gap-3 py-1.5 pl-[22px] pr-4 text-[14.5px] text-fg-2 hover:bg-canvas/25" data-mid={m.id}>
      <span className="flex w-[34px] shrink-0 justify-center">{icon}</span>
      <span className="min-w-0 flex-1">
        {body}
        <span className="ml-2 text-[12px] text-fg-3">{time}</span>
      </span>
    </div>
  );
}

export const MessageRow = memo(function MessageRow({ m, grouped, me, highlight }: RowProps) {
  const pending = m.id.startsWith(PENDING_PREFIX);
  const pend = useMessages((s) => (pending && m.nonce ? s.pending[m.nonce] : undefined));
  const editing = useUI((s) => s.editing === m.id);
  const mentionsMe = useMentionsMe(m, me);
  const blocked = useData((s) => s.relationships[m.author.id]?.type === RelationshipType.BLOCKED);
  const compact = useSettings((s) => s.density === "compact");
  const [showBlocked, setShowBlocked] = useState(false);
  const menu = useContextMenu();
  const reactPop = usePopover();
  const long = useLongPress((e) => menu(e, messageMenu(m, me)));

  if (m.type !== MessageType.DEFAULT && m.type !== MessageType.REPLY) return <SystemRow m={m} />;
  if (blocked && !showBlocked) {
    return (
      <div className="flex items-center gap-2 py-1 pl-[72px] text-[13px] text-fg-3">
        {t("chat.blockedMessage")}
        <button onClick={() => setShowBlocked(true)} className="font-semibold text-sky hover:underline">
          {t("chat.show")}
        </button>
      </div>
    );
  }

  const openProfile = () => useUI.getState().setModal({ kind: "profile", userId: m.author.id, guildId: m.guildId });
  const showHeader = !grouped || !!m.replyTo;

  return (
    <div
      data-mid={m.id}
      onContextMenu={(e) => !pending && menu(e, messageMenu(m, me))}
      {...(isTouch && !pending ? long : {})}
      className={clsx(
        "group/msg relative pr-4 transition-colors",
        showHeader ? (compact ? "mt-1 pt-0.5" : "mt-[14px] pt-0.5") : "",
        mentionsMe ? "bg-star/[0.07] before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-star" : "hover:bg-canvas/25",
        highlight && "anim-flash",
        pending && pend?.state !== "failed" && "opacity-60"
      )}
    >
      {m.replyTo && <ReplyPreview m={m} />}
      <div className={clsx("flex gap-4 pl-4", compact && "gap-2")}>
        <div className={clsx("shrink-0", compact ? "w-[52px] pt-[3px] text-right" : "w-10")}>
          {compact ? (
            <span className="text-[11px] tabular-nums text-fg-3">{fmtTime(m.createdAt)}</span>
          ) : showHeader ? (
            <button onClick={openProfile} className="mt-0.5 rounded-full transition-transform active:scale-95" aria-label={m.author.username}>
              <UserAvatar userId={m.author.id} size={40} showStatus={false} />
            </button>
          ) : (
            <Tooltip content={fmtDateTime(m.createdAt)}>
              <span className="block pt-[3px] text-right text-[11px] tabular-nums leading-[22px] text-fg-3 opacity-0 group-hover/msg:opacity-100">{fmtTime(m.createdAt)}</span>
            </Tooltip>
          )}
        </div>
        <div className="min-w-0 flex-1 py-0.5">
          {showHeader && !compact && (
            <div className="flex min-w-0 items-baseline gap-2">
              <AuthorName m={m} onClick={openProfile} />
              <Tooltip content={fmtDateTime(m.createdAt)}>
                <span className="shrink-0 text-[12px] text-fg-3">{fmtMessageTime(m.createdAt)}</span>
              </Tooltip>
            </div>
          )}
          {editing ? (
            <EditBox m={m} />
          ) : (
            <div className={clsx(compact && "flex gap-2")}>
              {compact && (
                <span className="shrink-0">
                  <AuthorName m={m} onClick={openProfile} />
                </span>
              )}
              {m.content && (
                <div className="min-w-0 text-[15.5px] leading-[1.42] text-fg">
                  <Markdown content={m.content} guildId={m.guildId} />
                  {m.editedAt && (
                    <Tooltip content={t("chat.editedAt", { time: fmtDateTime(m.editedAt) })}>
                      <span className="ml-1 text-[11px] text-fg-3">({t("chat.edited")})</span>
                    </Tooltip>
                  )}
                </div>
              )}
            </div>
          )}
          {m.attachments.length > 0 && <Attachments items={m.attachments} />}
          {m.embeds.length > 0 && !(m.flags & MessageFlags.SUPPRESS_EMBEDS) && <Embeds items={m.embeds} />}
          {m.poll && <Poll m={m} me={me} />}
          <ThreadChip m={m} />
          <Reactions m={m} me={me} />
          {pend?.state === "failed" && (
            <div className="mt-1 flex items-center gap-2 text-[13px] text-bad">
              <AlertCircle size={14} /> {pend.error ? errorText({ code: pend.error }) : t("chat.failed")}
              <button onClick={() => void retrySend(m.nonce!)} className="font-semibold text-sky hover:underline">
                {t("chat.retry")}
              </button>
              <button onClick={() => discardPending(m.nonce!)} className="font-semibold text-fg-3 hover:underline">
                {t("chat.discard")}
              </button>
            </div>
          )}
        </div>
      </div>

      {!pending && !editing && !isTouch && (
        <div className="absolute -top-4 right-4 z-10 flex items-center rounded-xl bg-panel p-0.5 opacity-0 shadow-lift hairline transition-opacity group-hover/msg:opacity-100 has-[button:focus-visible]:opacity-100">
          {QUICK.map((e) => (
            <button key={e} onClick={() => toggleReaction(m, e, !!m.reactions.find((r) => r.emoji === e)?.users.includes(me))} className="flex h-8 w-8 items-center justify-center rounded-lg text-[17px] transition-transform hover:scale-110 hover:bg-raised" aria-label={e}>
              <ReactionEmoji emoji={e} size={17} />
            </button>
          ))}
          <ToolBtn label={t("chat.menu.react")} onClick={reactPop.toggle}>
            <SmilePlus size={17} />
          </ToolBtn>
          <ToolBtn label={t("chat.menu.reply")} onClick={() => useUI.setState({ replyTo: { ...useUI.getState().replyTo, [m.channelId]: m } })}>
            <Reply size={17} />
          </ToolBtn>
          {m.author.id === me && (
            <ToolBtn label={t("chat.menu.edit")} onClick={() => useUI.setState({ editing: m.id })}>
              <Pencil size={16} />
            </ToolBtn>
          )}
          <ToolBtn label={t("common.more")} onClick={(e) => menu(e.currentTarget.getBoundingClientRect(), messageMenu(m, me))}>
            <MoreHorizontal size={17} />
          </ToolBtn>
        </div>
      )}
      <Popover anchor={reactPop.anchor} onClose={reactPop.close} placement="left-start">
        <EmojiPicker onClose={reactPop.close} onPick={(e) => toggleReaction(m, e.key, !!m.reactions.find((r) => r.emoji === e.key)?.users.includes(me))} />
      </Popover>
    </div>
  );
});

function ToolBtn({ label, onClick, children }: { label: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; children: React.ReactNode }) {
  return (
    <Tooltip content={label}>
      <button onClick={onClick} className="flex h-8 w-8 items-center justify-center rounded-lg text-fg-2 transition-colors hover:bg-raised hover:text-fg" aria-label={label}>
        {children}
      </button>
    </Tooltip>
  );
}

function EditBox({ m }: { m: MessageDTO }) {
  const initial = useRef(tokensToText(m.content, data(), m.guildId));
  const [text, setText] = useState(initial.current.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight, 400) + "px";
  }, [text]);
  const close = () => useUI.setState({ editing: null });
  const save = async () => {
    const content = textToTokens(text.trim(), initial.current.map, data(), m.guildId, m.channelId);
    close();
    if (content === m.content) return;
    if (!content && !m.attachments.length) return deleteWithConfirm(m, false);
    try {
      await api(`/api/channels/${m.channelId}/messages/${m.id}`, { method: "PATCH", body: { content } });
    } catch (e) {
      toast(errorText(e), "error");
    }
  };
  return (
    <div className="mt-1">
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void save();
          }
        }}
        className="w-full resize-none rounded-xl bg-raised px-3 py-2.5 text-[15.5px] leading-[1.42] outline-none ring-1 ring-star/40"
      />
      <div className="mt-1 text-[12px] text-fg-3">
        Esc — <button className="text-sky hover:underline" onClick={close}>{t("common.cancel").toLowerCase()}</button> · Enter —{" "}
        <button className="text-sky hover:underline" onClick={() => void save()}>
          {t("common.save").toLowerCase()}
        </button>
      </div>
    </div>
  );
}

function deleteWithConfirm(m: MessageDTO, skipConfirm: boolean) {
  const run = () => api(`/api/channels/${m.channelId}/messages/${m.id}`, { method: "DELETE" }).catch((e) => toast(errorText(e), "error"));
  if (skipConfirm) return void run();
  confirmDialog({ title: t("chat.deleteTitle"), body: t("chat.deleteConfirm"), danger: true, confirmLabel: t("common.delete"), onConfirm: () => run() });
}

let shiftDown = false;
window.addEventListener("keydown", (e) => (shiftDown = e.shiftKey));
window.addEventListener("keyup", (e) => (shiftDown = e.shiftKey));

export function messageMenu(m: MessageDTO, me: string): MenuEntry[] {
  const s = data();
  const bits = channelPerms(s, m.channelId);
  const own = m.author.id === me;
  const mod = !!m.guildId && can(bits, Permission.MANAGE_MESSAGES);
  const canPin = m.guildId ? mod : true;
  const link = webLink(`/#/channels/${m.guildId ?? "@me"}/${m.channelId}/${m.id}`);
  const copy = (v: string) => {
    void navigator.clipboard?.writeText(v);
    toast(t("common.copied"), "success");
  };
  return [
    {
      label: t("chat.menu.react"),
      icon: <SmilePlus size={16} />,
      onSelect: () => {
        const r = document.querySelector(`[data-mid="${m.id}"]`)?.getBoundingClientRect();
        useUI.setState({ reactPicker: { m, x: r ? r.right - 40 : window.innerWidth / 2, y: r ? r.top : window.innerHeight / 2 } });
      },
    },
    { label: t("chat.menu.reply"), icon: <Reply size={16} />, onSelect: () => useUI.setState({ replyTo: { ...useUI.getState().replyTo, [m.channelId]: m } }) },
    own && m.type <= 19 && { label: t("chat.menu.edit"), icon: <Pencil size={16} />, onSelect: () => useUI.setState({ editing: m.id }) },
    m.guildId && !m.thread && can(bits, Permission.CREATE_THREADS) && {
      label: t("chat.menu.thread"),
      icon: <MessagesSquare size={16} />,
      onSelect: async () => {
        const name = (m.content || t("channel.threadDefault")).replace(/\s+/g, " ").slice(0, 60);
        try {
          const th = await api<{ id: string }>(`/api/channels/${m.channelId}/threads`, { method: "POST", body: { name, messageId: m.id } });
          useUI.setState({ threadId: th.id, panel: "thread" });
        } catch (e) {
          toast(errorText(e), "error");
        }
      },
    },
    m.thread && { label: t("chat.menu.openThread"), icon: <MessagesSquare size={16} />, onSelect: () => useUI.setState({ threadId: m.thread!.id, panel: "thread" }) },
    canPin && {
      label: m.pinned ? t("chat.menu.unpin") : t("chat.menu.pin"),
      icon: m.pinned ? <PinOff size={16} /> : <Pin size={16} />,
      onSelect: () => void api(`/api/channels/${m.channelId}/pins/${m.id}`, { method: m.pinned ? "DELETE" : "PUT" }).catch((e) => toast(errorText(e), "error")),
    },
    { label: t("chat.menu.bookmark"), icon: <Bookmark size={16} />, onSelect: () => void api(`/api/users/@me/bookmarks/${m.id}`, { method: "PUT" }).then(() => toast(t("bookmarks.saved"), "success")) },
    {
      label: t("chat.menu.markUnread"),
      icon: <EyeOff size={16} />,
      onSelect: () => {
        const list = useMessages.getState().logs[m.channelId]?.list ?? [];
        const idx = list.findIndex((x) => x.id === m.id);
        const prev = idx > 0 ? list[idx - 1].id : null;
        useUI.setState({ markedUnread: { channelId: m.channelId, afterId: prev } });
        void api(`/api/channels/${m.channelId}/ack`, { method: "POST", body: { messageId: prev } });
      },
    },
    { separator: true },
    m.content && { label: t("chat.menu.copyText"), icon: <Copy size={16} />, onSelect: () => copy(toPlain(m.content, { user: (id) => displayName(s, id, m.guildId), role: (id) => s.roles[m.guildId ?? ""]?.[id]?.name ?? "", channel: (id) => s.channels[id]?.name ?? "" })) },
    { label: t("chat.menu.copyLink"), icon: <Link2 size={16} />, onSelect: () => copy(link) },
    mod && !own && m.embeds.length > 0 && { label: t("chat.menu.removeEmbeds"), icon: <Hash size={16} />, onSelect: () => void api(`/api/channels/${m.channelId}/messages/${m.id}`, { method: "PATCH", body: { content: m.content, suppressEmbeds: true } }) },
    settings().developerMode && { label: t("chat.menu.copyId"), icon: <CornerUpRight size={16} />, onSelect: () => copy(m.id) },
    (own || mod) && { separator: true },
    (own || mod) && { label: t("chat.menu.delete"), icon: <Trash2 size={16} />, danger: true, onSelect: () => deleteWithConfirm(m, shiftDown) },
  ];
}
