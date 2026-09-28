import { useEffect, useMemo, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import clsx from "clsx";
import { Crown, X, Search as SearchIcon, Loader2, MessagesSquare, Archive, Trash2, Plus, ArrowLeft } from "lucide-react";
import type { ChannelDTO, MessageDTO, SearchResultDTO } from "@nova/shared";
import { api } from "../../lib/api";
import { errorText, t } from "../../lib/i18n";
import { toast } from "../../lib/bus";
import { fmtMessageTime } from "../../lib/time";
import { useDebounced } from "../../lib/hooks";
import { channelTitle, displayName, roleColor, useData, type DataState } from "../../store/data";
import { navigate, useUI } from "../../store/ui";
import { jumpTo } from "../../store/messages";
import { IconButton } from "../../components/ui/primitives";
import { useContextMenu } from "../../components/ui/overlay";
import { UserAvatar } from "../../components/ui/avatar";
import { Markdown } from "../chat/markdown";
import { Attachments } from "../chat/MessageParts";
import { MessageList } from "../chat/MessageList";
import { Composer } from "../chat/Composer";
import { userMenu } from "../shell/menus";
import { activityText } from "../people/presence";

export function RightPanel() {
  const panel = useUI((s) => s.panel);
  const guildId = useUI((s) => s.guildId);
  if (panel === "pins") return <PinsPanel />;
  if (panel === "search") return <SearchPanel />;
  if (panel === "thread") return <ThreadPanel />;
  if (panel === "inbox") return <InboxPanel />;
  if (panel === "bookmarks") return <BookmarksPanel />;
  if (guildId !== "@me") return <MemberList guildId={guildId} />;
  return null;
}

function PanelHeader({ title, icon, onBack }: { title: React.ReactNode; icon?: React.ReactNode; onBack?: () => void }) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line/8 px-3">
      {onBack && (
        <IconButton label={t("common.back")} onClick={onBack}>
          <ArrowLeft size={18} />
        </IconButton>
      )}
      {icon}
      <span className="min-w-0 flex-1 truncate font-semibold">{title}</span>
      <IconButton label={t("common.close")} onClick={() => useUI.setState({ panel: null })}>
        <X size={18} />
      </IconButton>
    </div>
  );
}

// ── members ──────────────────────────────────────────────────────────────────
type MemberRow = { kind: "header"; label: string; count: number } | { kind: "member"; userId: string; offline: boolean };

function buildMembers(s: DataState, guildId: string): MemberRow[] {
  const members = Object.values(s.members[guildId] ?? {});
  const roles = Object.values(s.roles[guildId] ?? {})
    .filter((r) => r.hoist && r.id !== guildId)
    .sort((a, b) => b.position - a.position);
  const groups = new Map<string, string[]>();
  const online: string[] = [];
  const offline: string[] = [];
  for (const m of members) {
    const p = s.presences[m.userId];
    if (!p) {
      offline.push(m.userId);
      continue;
    }
    const top = roles.find((r) => m.roles.includes(r.id));
    if (top) groups.set(top.id, [...(groups.get(top.id) ?? []), m.userId]);
    else online.push(m.userId);
  }
  const byName = (a: string, b: string) => displayName(s, a, guildId).localeCompare(displayName(s, b, guildId), "ru");
  const rows: MemberRow[] = [];
  for (const r of roles) {
    const list = groups.get(r.id);
    if (!list?.length) continue;
    rows.push({ kind: "header", label: r.name, count: list.length });
    for (const u of list.sort(byName)) rows.push({ kind: "member", userId: u, offline: false });
  }
  if (online.length) {
    rows.push({ kind: "header", label: t("common.online"), count: online.length });
    for (const u of online.sort(byName)) rows.push({ kind: "member", userId: u, offline: false });
  }
  if (offline.length) {
    rows.push({ kind: "header", label: t("common.offline"), count: offline.length });
    for (const u of offline.sort(byName).slice(0, 1000)) rows.push({ kind: "member", userId: u, offline: true });
  }
  return rows;
}

function MemberList({ guildId }: { guildId: string }) {
  const members = useData((s) => s.members[guildId]);
  const presences = useData((s) => s.presences);
  const roles = useData((s) => s.roles[guildId]);
  const rows = useMemo(() => buildMembers(useData.getState(), guildId), [members, presences, roles, guildId]);
  const panel = useUI((s) => s.panel);
  return (
    <div className="flex h-full flex-col">
      {panel === "members" && <PanelHeader title={t("common.members")} />}
      <Virtuoso
        className="scroll-thin flex-1"
        data={rows}
        computeItemKey={(i, r) => (r.kind === "header" ? `h${i}` : r.userId)}
        itemContent={(_, r) =>
          r.kind === "header" ? (
            <div className="px-4 pb-1 pt-5 text-[12.5px] font-semibold text-fg-3">
              {r.label} — {r.count}
            </div>
          ) : (
            <MemberItem userId={r.userId} guildId={guildId} offline={r.offline} />
          )
        }
      />
    </div>
  );
}

function MemberItem({ userId, guildId, offline }: { userId: string; guildId: string; offline: boolean }) {
  const name = useData((s) => displayName(s, userId, guildId));
  const color = useData((s) => roleColor(s, guildId, userId));
  const owner = useData((s) => s.guilds[guildId]?.ownerId === userId);
  const presence = useData((s) => s.presences[userId]);
  const menu = useContextMenu();
  const sub = activityText(presence);
  return (
    <button
      onClick={() => useUI.getState().setModal({ kind: "profile", userId, guildId })}
      onContextMenu={(e) => menu(e, userMenu(userId, guildId))}
      className={clsx("mx-2 flex w-[calc(100%-1rem)] items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-raised/60", offline && "opacity-40 hover:opacity-100")}
    >
      <UserAvatar userId={userId} size={34} statusRing="ring-panel" showStatus={!offline} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className="truncate text-[15px] font-medium" style={color ? { color } : undefined}>
            {name}
          </span>
          {owner && <Crown size={13} className="shrink-0 text-warn" />}
        </div>
        {sub && <div className="truncate text-[12px] text-fg-3">{sub}</div>}
      </div>
    </button>
  );
}

// ── message previews ─────────────────────────────────────────────────────────
function MessagePreview({ m, onJump, action }: { m: MessageDTO; onJump?: () => void; action?: React.ReactNode }) {
  const name = useData((s) => displayName(s, m.author.id, m.guildId));
  const color = useData((s) => roleColor(s, m.guildId, m.author.id));
  const where = useData((s) => {
    const c = s.channels[m.channelId];
    return c ? (c.guildId ? `#${c.name}` : channelTitle(s, c)) : "";
  });
  return (
    <div className="group relative rounded-xl bg-raised/50 p-3 hairline transition-colors hover:bg-raised">
      <div className="mb-1 text-[11.5px] text-fg-3">{where}</div>
      <div className="flex gap-3">
        <UserAvatar userId={m.author.id} size={32} showStatus={false} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[14px] font-semibold" style={color ? { color } : undefined}>
              {name}
            </span>
            <span className="shrink-0 text-[11.5px] text-fg-3">{fmtMessageTime(m.createdAt)}</span>
          </div>
          {m.content && (
            <div className="line-clamp-6 text-[14px]">
              <Markdown content={m.content} guildId={m.guildId} />
            </div>
          )}
          {m.attachments.length > 0 && <Attachments items={m.attachments.slice(0, 1)} />}
        </div>
      </div>
      <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 touch-visible">
        {action}
        {onJump && (
          <button onClick={onJump} className="rounded-lg bg-canvas px-2 py-1 text-[12px] font-semibold text-fg-2 hover:text-fg">
            {t("chat.jump")}
          </button>
        )}
      </div>
    </div>
  );
}

const jump = (m: MessageDTO) => {
  const c = useData.getState().channels[m.channelId];
  if (!c) return;
  if (c.type === "thread") useUI.setState({ threadId: c.id, panel: "thread" });
  else navigate(c.guildId ?? "@me", c.id);
  void jumpTo(m.channelId, m.id);
};

function ListState({ loading, empty, children }: { loading: boolean; empty: string | null; children: React.ReactNode }) {
  if (loading)
    return (
      <div className="flex flex-1 items-center justify-center text-fg-3">
        <Loader2 className="anim-spin" />
      </div>
    );
  if (empty) return <div className="flex flex-1 items-center justify-center p-8 text-center text-[14px] text-fg-3">{empty}</div>;
  return <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">{children}</div>;
}

function PinsPanel() {
  const channelId = useUI((s) => s.channelId);
  const lastPin = useData((s) => (channelId ? s.channels[channelId]?.lastPinAt : null));
  const [pins, setPins] = useState<MessageDTO[] | null>(null);
  useEffect(() => {
    if (!channelId) return;
    setPins(null);
    api<MessageDTO[]>(`/api/channels/${channelId}/pins`).then(setPins).catch(() => setPins([]));
  }, [channelId, lastPin]);
  return (
    <div className="flex h-full flex-col">
      <PanelHeader title={t("chat.pinned")} />
      <ListState loading={!pins} empty={pins && !pins.length ? t("chat.noPins") : null}>
        {pins?.map((m) => (
          <MessagePreview key={m.id} m={m} onJump={() => jump(m)} />
        ))}
      </ListState>
    </div>
  );
}

function SearchPanel() {
  const guildId = useUI((s) => s.guildId);
  const channelId = useUI((s) => s.channelId);
  const [q, setQ] = useState(useUI.getState().searchQuery);
  const query = useDebounced(q, 400);
  const [res, setRes] = useState<SearchResultDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const parsed = parseSearch(query);
    if (!parsed) return setRes(null);
    setLoading(true);
    const s = useData.getState();
    const author = parsed.from ? Object.values(s.users).find((u) => u.username === parsed.from.toLowerCase())?.id : undefined;
    const path = guildId !== "@me" ? `/api/guilds/${guildId}/messages/search` : `/api/channels/${channelId}/messages/search`;
    api<SearchResultDTO>(path, { query: { content: parsed.text || undefined, authorId: author, has: parsed.has.join(",") || undefined, channelId: parsed.inChannel, offset } })
      .then(setRes)
      .catch((e) => {
        toast(errorText(e), "error");
        setRes({ total: 0, messages: [] });
      })
      .finally(() => setLoading(false));
  }, [query, guildId, channelId, offset]);

  const hasChips = ["link", "file", "image", "video", "sound", "poll"];
  return (
    <div className="flex h-full flex-col">
      <PanelHeader title={t("common.search")} />
      <div className="border-b border-line/8 p-3">
        <div className="relative">
          <SearchIcon size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-3" />
          <input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOffset(0);
            }}
            placeholder={t("search.placeholder")}
            className="h-10 w-full rounded-xl bg-canvas/70 pl-9 pr-3 text-[14.5px] outline-none ring-1 ring-line/10 focus:ring-star/60"
          />
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {hasChips.map((h) => (
            <button
              key={h}
              onClick={() => setQ((v) => (v.includes(`has:${h}`) ? v.replace(`has:${h}`, "").trim() : `${v} has:${h}`.trim()))}
              className={clsx("rounded-lg px-2 py-0.5 text-[12.5px] font-medium ring-1", q.includes(`has:${h}`) ? "bg-star/15 text-star ring-star/40" : "text-fg-2 ring-line/15 hover:text-fg")}
            >
              {t("search.has")} {t(`search.has${h[0].toUpperCase()}${h.slice(1)}`)}
            </button>
          ))}
        </div>
      </div>
      {res && !loading && <div className="px-4 pt-3 text-[12.5px] font-semibold text-fg-3">{t("search.results", { n: res.total })}</div>}
      <ListState loading={loading} empty={res && !res.messages.length ? t("search.none") : null}>
        {res?.messages.map((m) => (
          <MessagePreview key={m.id} m={m} onJump={() => jump(m)} />
        ))}
        {res && res.total > offset + 25 && (
          <button onClick={() => setOffset(offset + 25)} className="rounded-xl py-2 text-[13.5px] font-semibold text-sky hover:bg-raised">
            {t("common.more")}
          </button>
        )}
      </ListState>
    </div>
  );
}

function parseSearch(q: string): { text: string; from: string; has: string[]; inChannel?: string } | null {
  const parts = q.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  let from = "";
  const has: string[] = [];
  const text: string[] = [];
  for (const p of parts) {
    const f = /^(?:from|от):@?(.+)$/i.exec(p);
    const h = /^(?:has|есть):(\w+)$/i.exec(p);
    if (f) from = f[1];
    else if (h) has.push(h[1].toLowerCase());
    else text.push(p);
  }
  const joined = text.join(" ");
  if (joined.length < 2 && !from && !has.length) return null;
  return { text: joined, from, has };
}

function ThreadPanel() {
  const threadId = useUI((s) => s.threadId);
  const channelId = useUI((s) => s.channelId);
  const thread = useData((s) => (threadId ? s.channels[threadId] : undefined));
  if (!threadId || !thread) return <ThreadList parentId={channelId} />;
  return (
    <div className="flex h-full flex-col">
      <PanelHeader title={thread.name} icon={<MessagesSquare size={18} className="text-star" />} onBack={() => useUI.setState({ threadId: null })} />
      <div className="flex min-h-0 flex-1 flex-col">
        <MessageList key={threadId} channelId={threadId} />
        <Composer channelId={threadId} compact placeholderOverride={t("chat.placeholderChannel", { name: thread.name })} />
      </div>
    </div>
  );
}

function ThreadList({ parentId }: { parentId: string | null }) {
  const [archived, setArchived] = useState(false);
  const [list, setList] = useState<ChannelDTO[] | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const live = useData((s) => s.channels);
  useEffect(() => {
    if (!parentId) return;
    setList(null);
    api<ChannelDTO[]>(`/api/channels/${parentId}/threads`, { query: { archived } }).then(setList).catch(() => setList([]));
  }, [parentId, archived, live]);
  const create = async () => {
    const name = draft;
    setDraft(null);
    if (!name?.trim() || !parentId) return;
    try {
      const th = await api<ChannelDTO>(`/api/channels/${parentId}/threads`, { method: "POST", body: { name: name.trim() } });
      useUI.setState({ threadId: th.id });
    } catch (e) {
      toast(errorText(e), "error");
    }
  };
  return (
    <div className="flex h-full flex-col">
      <PanelHeader title={t("channel.threads")} icon={<MessagesSquare size={18} className="text-star" />} />
      <div className="flex gap-2 p-3">
        <button onClick={() => setArchived(false)} className={clsx("rounded-lg px-2.5 py-1 text-[13px] font-semibold", !archived ? "bg-raised" : "text-fg-3")}>
          {t("channel.threadsActive")}
        </button>
        <button onClick={() => setArchived(true)} className={clsx("flex items-center gap-1 rounded-lg px-2.5 py-1 text-[13px] font-semibold", archived ? "bg-raised" : "text-fg-3")}>
          <Archive size={13} /> {t("channel.threadsArchived")}
        </button>
        <span className="flex-1" />
        <button onClick={() => setDraft("")} className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-[13px] font-semibold text-star hover:bg-star/10">
          <Plus size={14} /> {t("channel.threadNew")}
        </button>
      </div>
      {draft !== null && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
          className="px-3 pb-2"
        >
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setDraft(null)}
            onBlur={() => !draft && setDraft(null)}
            placeholder={t("chat.threadNamePlaceholder")}
            maxLength={100}
            className="h-10 w-full rounded-xl bg-canvas/70 px-3 text-[14.5px] outline-none ring-1 ring-star/50"
          />
        </form>
      )}
      <ListState loading={!list} empty={list && !list.length ? t("channel.threadsEmpty") : null}>
        {list?.map((th) => (
          <button key={th.id} onClick={() => useUI.setState({ threadId: th.id })} className="flex items-center gap-3 rounded-xl bg-raised/50 p-3 text-left hairline hover:bg-raised">
            <MessagesSquare size={18} className="shrink-0 text-star" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">{th.name}</div>
              <div className="text-[12.5px] text-fg-3">{t("chat.threadReplies", { n: th.thread?.messageCount ?? 0 })}</div>
            </div>
          </button>
        ))}
      </ListState>
    </div>
  );
}

function InboxPanel() {
  const [list, setList] = useState<MessageDTO[] | null>(null);
  useEffect(() => {
    api<MessageDTO[]>("/api/users/@me/mentions").then(setList).catch(() => setList([]));
  }, []);
  return (
    <div className="flex h-full flex-col">
      <PanelHeader title={t("mentions.title")} />
      <ListState loading={!list} empty={list && !list.length ? t("mentions.empty") : null}>
        {list?.map((m) => (
          <MessagePreview key={m.id} m={m} onJump={() => jump(m)} />
        ))}
      </ListState>
    </div>
  );
}

function BookmarksPanel() {
  const [list, setList] = useState<MessageDTO[] | null>(null);
  useEffect(() => {
    api<MessageDTO[]>("/api/users/@me/bookmarks").then(setList).catch(() => setList([]));
  }, []);
  const remove = (id: string) => {
    void api(`/api/users/@me/bookmarks/${id}`, { method: "DELETE" });
    setList((l) => l?.filter((m) => m.id !== id) ?? null);
  };
  return (
    <div className="flex h-full flex-col">
      <PanelHeader title={t("bookmarks.title")} />
      <ListState loading={!list} empty={list && !list.length ? t("bookmarks.empty") : null}>
        {list?.map((m) => (
          <MessagePreview
            key={m.id}
            m={m}
            onJump={() => jump(m)}
            action={
              <button onClick={() => remove(m.id)} className="rounded-lg bg-canvas p-1 text-fg-2 hover:text-bad" aria-label={t("chat.menu.unbookmark")}>
                <Trash2 size={14} />
              </button>
            }
          />
        ))}
      </ListState>
    </div>
  );
}
