import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import clsx from "clsx";
import { ArrowDown, Loader2 } from "lucide-react";
import { MessageType, compareIds, ulidTime, type MessageDTO } from "@nova/shared";
import { api } from "../../lib/api";
import { t } from "../../lib/i18n";
import { fmtDayDivider, fmtTime, isSameDay } from "../../lib/time";
import { channelTitle, isUnread, useData } from "../../store/data";
import { clearJump, jumpToPresent, loadAfter, loadBefore, loadInitial, PENDING_PREFIX, useMessages } from "../../store/messages";
import { useUI } from "../../store/ui";
import { Popover, pointRect } from "../../components/ui/overlay";
import { MessageRow } from "./Message";
import { EmojiPicker } from "./EmojiPicker";
import { toggleReaction } from "./MessageParts";
import { channelIcon } from "../shell/GuildSidebar";
import { UserAvatar } from "../../components/ui/avatar";

interface Item {
  m: MessageDTO;
  grouped: boolean;
  day: boolean;
  unread: boolean;
}

const GROUP_MS = 7 * 60_000;
const START_INDEX = 1_000_000;

function build(list: MessageDTO[], unreadAfter: string | null | undefined, me: string): Item[] {
  const out: Item[] = [];
  let prev: MessageDTO | null = null;
  let unreadPlaced = false;
  for (const m of list) {
    const t = m.id.startsWith(PENDING_PREFIX) ? Date.parse(m.createdAt) : ulidTime(m.id);
    const pt = prev ? (prev.id.startsWith(PENDING_PREFIX) ? Date.parse(prev.createdAt) : ulidTime(prev.id)) : 0;
    const day = !prev || !isSameDay(t, pt);
    const unread = !unreadPlaced && unreadAfter !== undefined && !m.id.startsWith(PENDING_PREFIX) && compareIds(m.id, unreadAfter) > 0 && m.author.id !== me;
    if (unread) unreadPlaced = true;
    const system = (x: MessageDTO) => x.type !== MessageType.DEFAULT && x.type !== MessageType.REPLY;
    const grouped = !!prev && !day && !unread && prev.author.id === m.author.id && !system(prev) && !system(m) && t - pt < GROUP_MS;
    out.push({ m, grouped, day, unread });
    prev = m;
  }
  return out;
}

const Row = memo(function Row({ item, me, highlight }: { item: Item; me: string; highlight: boolean }) {
  return (
    <div>
      {item.day && (
        <div className={clsx("flex items-center gap-3 px-4 pb-1 pt-5", item.unread && "text-bad")}>
          <span className="h-px flex-1 bg-line/12" />
          <span className="text-[12px] font-semibold text-fg-3">{fmtDayDivider(item.m.createdAt)}</span>
          <span className="h-px flex-1 bg-line/12" />
        </div>
      )}
      {item.unread && (
        <div className="relative mx-4 mt-3 flex items-center">
          <span className="h-px flex-1 bg-bad/70" />
          <span className="ml-1 rounded-md bg-bad px-1.5 text-[10.5px] font-bold uppercase leading-4 text-white">{t("chat.newMessages")}</span>
        </div>
      )}
      <MessageRow m={item.m} grouped={item.grouped} me={me} highlight={highlight} />
    </div>
  );
});

function Welcome({ channelId }: { channelId: string }) {
  const c = useData((s) => s.channels[channelId]);
  const title = useData((s) => channelTitle(s, c));
  const partner = useData((s) => (c?.type === "dm" ? c.recipients.find((r) => r !== s.me?.id) : undefined));
  if (!c) return null;
  return (
    <div className="px-4 pb-2 pt-10">
      {partner ? (
        <UserAvatar userId={partner} size={80} showStatus={false} />
      ) : (
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-raised text-fg-2">{channelIcon(c, 34)}</div>
      )}
      <h2 className="mt-3 font-display text-[28px] font-semibold tracking-[-0.02em]">{c.type === "thread" ? title : c.guildId ? t("channel.welcome", { name: title }) : title}</h2>
      <p className="mt-1 text-[15px] text-fg-2">
        {c.type === "dm"
          ? t("channel.dmStart", { name: title })
          : c.type === "group_dm"
            ? t("channel.groupStart", { name: title })
            : c.type === "thread"
              ? t("channel.threadStart")
              : c.topic || t("channel.welcomeSub", { name: title })}
      </p>
    </div>
  );
}

export function MessageList({ channelId }: { channelId: string }) {
  const log = useMessages((s) => s.logs[channelId]);
  const jumpTarget = useMessages((s) => s.jump[channelId]);
  const me = useData((s) => s.me!.id);
  const marked = useUI((s) => (s.markedUnread?.channelId === channelId ? s.markedUnread : null));
  const reactPicker = useUI((s) => (s.reactPicker?.m.channelId === channelId ? s.reactPicker : null));
  const virt = useRef<VirtuosoHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  // Pinned to the end until the reader scrolls up: pictures and link previews
  // that finish loading below grow the list, and it follows them down.
  const pinned = useRef(true);
  const pinUntil = useRef(0);
  /** When the reader last scrolled by hand (wheel, touch, keys): only that unpins. */
  const handScroll = useRef(0);
  const byHand = () => (handScroll.current = performance.now());
  /** To the very end — at once, then again while what's there settles (an animated scroll aims at a moving target, jerks and stops short). */
  const toBottom = useCallback(() => {
    pinned.current = true;
    pinUntil.current = performance.now() + 1500;
    const go = () => virt.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
    go();
    requestAnimationFrame(() => requestAnimationFrame(go));
    setTimeout(go, 200);
  }, []);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [firstIndex, setFirstIndex] = useState(START_INDEX);
  const prevFirst = useRef<string | null>(null);
  const prevLen = useRef(0);

  // "New messages" divider: frozen at open, so it doesn't jump while reading.
  const dividerAfter = useRef<string | null | undefined>(undefined);
  if (dividerAfter.current === undefined) {
    const s = useData.getState();
    dividerAfter.current = isUnread(s, channelId) ? s.readStates[channelId]?.lastReadId ?? null : undefined;
  }
  const unreadAfter = marked ? marked.afterId : dividerAfter.current;

  useEffect(() => {
    void loadInitial(channelId);
  }, [channelId]);

  const items = useMemo(() => build(log?.list ?? [], unreadAfter, me), [log?.list, unreadAfter, me]);

  // Keep scroll position stable when older pages are prepended.
  useEffect(() => {
    const first = items[0]?.m.id ?? null;
    if (prevFirst.current && first && first !== prevFirst.current && compareIds(first, prevFirst.current) < 0) {
      const added = items.findIndex((i) => i.m.id === prevFirst.current);
      if (added > 0) setFirstIndex((x) => x - added);
    }
    // My own new message: always bring it into view.
    const last = items[items.length - 1];
    if (items.length > prevLen.current && last?.m.author.id === me && last.m.id.startsWith(PENDING_PREFIX)) {
      toBottom();
    }
    prevFirst.current = first;
    prevLen.current = items.length;
  }, [items, me, toBottom]);

  // Jump to a specific message (reply click, search, pins, links).
  useEffect(() => {
    if (!jumpTarget) return;
    const idx = items.findIndex((i) => i.m.id === jumpTarget);
    if (idx < 0) return;
    requestAnimationFrame(() => virt.current?.scrollToIndex({ index: idx, align: "center", behavior: "auto" }));
    setHighlight(jumpTarget);
    clearJump(channelId);
    const id = setTimeout(() => setHighlight(null), 1800);
    return () => clearTimeout(id);
  }, [jumpTarget, items, channelId]);

  // Mark read while the bottom of the channel is on screen and the window is focused.
  const ackTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const maybeAck = useCallback(() => {
    clearTimeout(ackTimer.current);
    ackTimer.current = setTimeout(() => {
      const s = useData.getState();
      if (!atBottom || log?.hasAfter || marked || document.visibilityState !== "visible" || !document.hasFocus()) return;
      if (!isUnread(s, channelId) && !(s.readStates[channelId]?.mentionCount ?? 0)) return;
      const lastId = s.channels[channelId]?.lastMessageId;
      useData.setState({ readStates: { ...s.readStates, [channelId]: { channelId, lastReadId: lastId ?? null, mentionCount: 0 } } });
      void api(`/api/channels/${channelId}/ack`, { method: "POST", body: { messageId: lastId ?? null } }).catch(() => {});
    }, 350);
  }, [atBottom, log?.hasAfter, marked, channelId]);

  const unreadNow = useData((s) => isUnread(s, channelId) || (s.readStates[channelId]?.mentionCount ?? 0) > 0);
  useEffect(() => {
    if (unreadNow) maybeAck();
  }, [unreadNow, maybeAck, items.length]);
  useEffect(() => {
    window.addEventListener("focus", maybeAck);
    return () => window.removeEventListener("focus", maybeAck);
  }, [maybeAck]);

  const initialIndex = useMemo(() => {
    const u = items.findIndex((i) => i.unread);
    // Opened at the first unread message: not pinned to the end until the reader gets there.
    pinned.current = u <= 0;
    return u > 0 ? { index: u, align: "center" as const } : { index: Math.max(0, items.length - 1), align: "end" as const };
    // Only for the first render of this channel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [log?.list.length ? channelId : null]);

  if (!log || (log.loading === "initial" && !log.list.length)) {
    return (
      <div className="flex flex-1 flex-col justify-end gap-5 overflow-hidden px-4 pb-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex gap-4 opacity-60">
            <div className="skeleton h-10 w-10 shrink-0 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <div className="skeleton h-3.5 rounded-full" style={{ width: `${18 + ((i * 13) % 20)}%` }} />
              <div className="skeleton h-3.5 rounded-full" style={{ width: `${40 + ((i * 29) % 45)}%` }} />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (log.error && !log.list.length) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-fg-2">
        {t("chat.loadError")}
        <button onClick={() => void loadInitial(channelId)} className="font-semibold text-sky hover:underline">
          {t("common.retry")}
        </button>
      </div>
    );
  }

  const unreadIdx = items.findIndex((i) => i.unread);
  const firstUnread = unreadIdx >= 0 ? items[unreadIdx].m : null;
  const unreadCount = unreadIdx >= 0 ? items.length - unreadIdx : 0;

  return (
    // A size container: pictures in messages measure themselves against the
    // chat (cqw/cqh), not the window — the chat beside a call is narrow and short.
    <div className="relative flex min-h-0 flex-1 flex-col [container-type:size]" onWheel={byHand} onTouchMove={byHand} onKeyDown={byHand} onPointerDown={byHand}>
      {firstUnread && !marked && unreadCount > 0 && dividerAfter.current !== undefined && !atBottom && (
        <div className="absolute inset-x-4 top-2 z-10 flex items-center rounded-xl bg-bad/90 px-3 py-1.5 text-[13px] font-semibold text-white shadow-lift anim-pop">
          <button className="flex-1 text-left" onClick={() => virt.current?.scrollToIndex({ index: unreadIdx, align: "center" })}>
            {t("chat.newSince", { n: unreadCount, time: fmtTime(firstUnread.createdAt) })}
          </button>
          <button onClick={() => (dividerAfter.current = undefined)} className="text-white/90 hover:text-white">
            {t("chat.markRead")}
          </button>
        </div>
      )}
      <Virtuoso
        ref={virt}
        className="scroll-thin flex-1"
        data={items}
        firstItemIndex={firstIndex}
        initialTopMostItemIndex={initialIndex}
        alignToBottom
        followOutput={(bottom) => (bottom || pinned.current ? "auto" : false)}
        atBottomThreshold={80}
        atBottomStateChange={(b) => {
          // Leaving the bottom by hand unpins; the list growing under the reader (a picture loading) doesn't.
          const now = performance.now();
          if (b) pinned.current = true;
          else if (now > pinUntil.current && now - handScroll.current < 1500) pinned.current = false;
          setAtBottom(b);
          if (b) maybeAck();
        }}
        totalListHeightChanged={() => {
          if (pinned.current && !log.hasAfter) virt.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
        }}
        startReached={() => {
          if (log.hasBefore) void loadBefore(channelId);
        }}
        endReached={() => {
          if (log.hasAfter) void loadAfter(channelId);
        }}
        // Rendered (and measured) well ahead, so rows don't change size on screen while scrolling.
        increaseViewportBy={{ top: 1200, bottom: 1200 }}
        // Keyed by nonce when present, so the optimistic row turns into the real one without remounting.
        computeItemKey={(_, it) => (it.m.nonce ? `n${it.m.nonce}` : it.m.id)}
        itemContent={(_, it) => <Row item={it} me={me} highlight={highlight === it.m.id} />}
        components={{
          Header: () =>
            log.hasBefore ? (
              <div className="flex h-16 items-center justify-center text-fg-3">{log.loading === "before" && <Loader2 className="anim-spin" size={20} />}</div>
            ) : (
              <Welcome channelId={channelId} />
            ),
          Footer: () => <div className="h-3">{log.loading === "after" && <Loader2 className="mx-auto anim-spin" size={18} />}</div>,
        }}
      />
      {(!atBottom || log.hasAfter) && (
        <button
          onClick={() => {
            if (log.hasAfter) void jumpToPresent(channelId).then(toBottom);
            else toBottom();
          }}
          className="glass absolute bottom-3 right-5 z-10 flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[13px] font-semibold text-fg shadow-lift anim-pop hover:text-star"
        >
          <ArrowDown size={15} /> {t("chat.jumpPresent")}
        </button>
      )}
      <Popover anchor={reactPicker ? pointRect(reactPicker.x, reactPicker.y) : null} onClose={() => useUI.setState({ reactPicker: null })} placement="left-start">
        {reactPicker && (
          <EmojiPicker
            onClose={() => useUI.setState({ reactPicker: null })}
            onPick={(e) => toggleReaction(reactPicker.m, e.key, !!reactPicker.m.reactions.find((r) => r.emoji === e.key)?.users.includes(me))}
          />
        )}
      </Popover>
    </div>
  );
}
