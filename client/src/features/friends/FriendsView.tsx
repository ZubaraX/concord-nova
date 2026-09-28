import { useMemo, useState, type FormEvent } from "react";
import clsx from "clsx";
import { ArrowLeft, Check, MessageSquare, MoreVertical, Phone, Search, Users, X, Volume2 } from "lucide-react";
import { RelationshipType } from "@nova/shared";
import { api } from "../../lib/api";
import { errorText, t } from "../../lib/i18n";
import { toast } from "../../lib/bus";
import { useIsMobile, useIsWide } from "../../lib/hooks";
import { channelTitle, displayName, useData } from "../../store/data";
import { navigate, useUI } from "../../store/ui";
import { IconButton, Button } from "../../components/ui/primitives";
import { useContextMenu } from "../../components/ui/overlay";
import { UserAvatar } from "../../components/ui/avatar";
import { callUser, openDmWith, userMenu } from "../shell/menus";
import { activityText } from "../people/presence";
import { NovaStar } from "../../components/Logo";

type Tab = "online" | "all" | "pending" | "blocked" | "add";

export function FriendsView() {
  const [tab, setTab] = useState<Tab>("online");
  const [q, setQ] = useState("");
  const rels = useData((s) => s.relationships);
  const presences = useData((s) => s.presences);
  const users = useData((s) => s.users);
  const mobile = useIsMobile();
  const wide = useIsWide();
  const pending = Object.values(rels).filter((r) => r.type === RelationshipType.INCOMING).length;

  const list = useMemo(() => {
    const all = Object.values(rels);
    const filtered =
      tab === "online"
        ? all.filter((r) => r.type === RelationshipType.FRIEND && presences[r.userId])
        : tab === "all"
          ? all.filter((r) => r.type === RelationshipType.FRIEND)
          : tab === "pending"
            ? all.filter((r) => r.type === RelationshipType.INCOMING || r.type === RelationshipType.OUTGOING)
            : tab === "blocked"
              ? all.filter((r) => r.type === RelationshipType.BLOCKED)
              : [];
    const needle = q.trim().toLowerCase();
    return filtered
      .filter((r) => !needle || (users[r.userId]?.username ?? "").includes(needle) || (users[r.userId]?.displayName ?? "").toLowerCase().includes(needle))
      .sort((a, b) => (users[a.userId]?.displayName || users[a.userId]?.username || "").localeCompare(users[b.userId]?.displayName || users[b.userId]?.username || "", "ru"));
  }, [rels, presences, users, tab, q]);

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: "online", label: t("friends.online") },
    { id: "all", label: t("friends.all") },
    { id: "pending", label: t("friends.pending"), badge: pending },
    { id: "blocked", label: t("friends.blocked") },
  ];

  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="scroll-thin flex h-12 shrink-0 items-center gap-2 overflow-x-auto border-b border-line/8 px-3">
          {mobile && (
            <IconButton label={t("common.back")} onClick={() => useUI.setState({ mobilePane: "nav" })}>
              <ArrowLeft size={20} />
            </IconButton>
          )}
          <Users size={20} className="shrink-0 text-fg-3" />
          <span className="mr-2 shrink-0 font-semibold">{t("friends.title")}</span>
          <span className="h-5 w-px shrink-0 bg-line/15" />
          {tabs.map((x) => (
            <button key={x.id} onClick={() => setTab(x.id)} className={clsx("flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-[14.5px] font-medium transition-colors", tab === x.id ? "bg-raised text-fg" : "text-fg-2 hover:bg-raised/60 hover:text-fg")}>
              {x.label}
              {!!x.badge && <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-bad px-1 text-[11px] font-bold text-white">{x.badge}</span>}
            </button>
          ))}
          <button onClick={() => setTab("add")} className={clsx("shrink-0 rounded-lg px-2.5 py-1 text-[14.5px] font-semibold transition-colors", tab === "add" ? "text-ok" : "bg-ok text-[#04150d] hover:brightness-110")}>
            {t("friends.add")}
          </button>
        </header>
        {tab === "add" ? (
          <AddFriend />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col px-5 pt-4">
            <div className="relative mb-3">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-3" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("common.search")} className="h-9 w-full rounded-lg bg-canvas/70 pl-9 pr-3 text-[14px] outline-none ring-1 ring-line/10 focus:ring-star/60" />
            </div>
            <div className="pb-2 text-[12.5px] font-semibold text-fg-3">
              {tabs.find((x) => x.id === tab)?.label} — {list.length}
            </div>
            <div className="scroll-thin min-h-0 flex-1 overflow-y-auto pb-4">
              {list.length ? (
                list.map((r) => <FriendRow key={r.userId} userId={r.userId} type={r.type} />)
              ) : (
                <EmptyState text={tab === "online" ? t("friends.emptyOnline") : tab === "all" ? t("friends.emptyAll") : tab === "pending" ? t("friends.emptyPending") : t("friends.emptyBlocked")} onAdd={tab === "blocked" ? undefined : () => setTab("add")} />
              )}
            </div>
          </div>
        )}
      </div>
      {wide && <ActiveNow />}
    </div>
  );
}

function EmptyState({ text, onAdd }: { text: string; onAdd?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
      <div className="relative">
        <NovaStar size={72} glow className="opacity-70" />
      </div>
      <p className="max-w-sm text-[15px] text-fg-2">{text}</p>
      {onAdd && (
        <Button variant="secondary" onClick={onAdd}>
          {t("friends.add")}
        </Button>
      )}
    </div>
  );
}

function FriendRow({ userId, type }: { userId: string; type: number }) {
  const u = useData((s) => s.users[userId]);
  const presence = useData((s) => s.presences[userId]);
  const menu = useContextMenu();
  if (!u) return null;
  const run = (p: Promise<unknown>) => p.catch((e) => toast(errorText(e), "error"));
  const sub =
    type === RelationshipType.INCOMING ? t("friends.incoming") : type === RelationshipType.OUTGOING ? t("friends.outgoing") : type === RelationshipType.BLOCKED ? t("friends.blocked") : activityText(presence) ?? t(`status.${presence?.status ?? "offline"}`);
  return (
    <div
      onClick={() => type === RelationshipType.FRIEND && void run(openDmWith(userId))}
      onContextMenu={(e) => menu(e, userMenu(userId))}
      className="group flex cursor-pointer items-center gap-3 border-t border-line/8 px-2 py-2.5 transition-colors first:border-t-0 hover:rounded-xl hover:border-transparent hover:bg-raised/60"
    >
      <UserAvatar userId={userId} size={38} statusRing="ring-surface" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="truncate font-semibold">{u.displayName || u.username}</span>
          <span className="truncate text-[13px] text-fg-3 opacity-0 transition-opacity group-hover:opacity-100">@{u.username}</span>
        </div>
        <div className="truncate text-[13px] text-fg-3">{sub}</div>
      </div>
      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
        {type === RelationshipType.FRIEND && (
          <>
            <RowBtn label={t("friends.message")} onClick={() => void run(openDmWith(userId))}>
              <MessageSquare size={18} />
            </RowBtn>
            <RowBtn label={t("friends.call")} onClick={() => void run(callUser(userId))}>
              <Phone size={18} />
            </RowBtn>
          </>
        )}
        {type === RelationshipType.INCOMING && (
          <RowBtn label={t("friends.accept")} onClick={() => void run(api(`/api/users/@me/relationships/${userId}`, { method: "PUT", body: {} }))} className="hover:!text-ok">
            <Check size={18} />
          </RowBtn>
        )}
        {(type === RelationshipType.INCOMING || type === RelationshipType.OUTGOING || type === RelationshipType.BLOCKED) && (
          <RowBtn label={type === RelationshipType.BLOCKED ? t("friends.unblock") : type === RelationshipType.INCOMING ? t("friends.ignore") : t("friends.cancelRequest")} onClick={() => void run(api(`/api/users/@me/relationships/${userId}`, { method: "DELETE" }))} className="hover:!text-bad">
            <X size={18} />
          </RowBtn>
        )}
        <RowBtn label={t("common.more")} onClick={(e) => menu(e.currentTarget.getBoundingClientRect(), userMenu(userId))}>
          <MoreVertical size={18} />
        </RowBtn>
      </div>
    </div>
  );
}

function RowBtn({ label, onClick, children, className }: { label: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; children: React.ReactNode; className?: string }) {
  return (
    <button onClick={onClick} aria-label={label} title={label} className={clsx("flex h-9 w-9 items-center justify-center rounded-full bg-canvas/70 text-fg-2 transition-colors hover:text-fg", className)}>
      {children}
    </button>
  );
}

function AddFriend() {
  const [value, setValue] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    // Username, "@username" or the display name — the server resolves it.
    const query = value.trim();
    if (!query) return;
    setBusy(true);
    try {
      const { userId } = await api<{ userId: string }>("/api/users/@me/relationships", { method: "POST", body: { username: query } });
      const u = useData.getState().users[userId];
      setResult({ ok: true, text: t("friends.requestSent", { name: u ? `${u.displayName || u.username} (@${u.username})` : query }) });
      setValue("");
    } catch (err) {
      setResult({ ok: false, text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="px-6 py-5">
      <h2 className="font-display text-[18px] font-semibold">{t("friends.addTitle")}</h2>
      <p className="mt-1 text-[14px] text-fg-2">{t("friends.addSubtitle")}</p>
      <form onSubmit={submit} className={clsx("mt-4 flex items-center gap-2 rounded-xl bg-canvas/70 p-2 ring-1", result ? (result.ok ? "ring-ok/60" : "ring-bad/60") : "ring-line/10 focus-within:ring-star/60")}>
        <span className="pl-2 text-fg-3">@</span>
        <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder={t("friends.addPlaceholder")} className="h-9 flex-1 bg-transparent text-[15px] outline-none" />
        <Button type="submit" size="sm" loading={busy} disabled={!value.trim()}>
          {t("friends.sendRequest")}
        </Button>
      </form>
      {result && <p className={clsx("mt-2 text-[13.5px]", result.ok ? "text-ok" : "text-bad")}>{result.text}</p>}
    </div>
  );
}

function ActiveNow() {
  const rels = useData((s) => s.relationships);
  const presences = useData((s) => s.presences);
  const voice = useData((s) => s.voiceStates);
  const s = useData.getState();
  const active = Object.values(rels)
    .filter((r) => r.type === RelationshipType.FRIEND && (voice[r.userId] || presences[r.userId]?.activities.length))
    .slice(0, 12);
  return (
    <aside className="scroll-thin w-[340px] shrink-0 overflow-y-auto border-l border-line/8 px-4 py-5">
      <h3 className="font-display text-[17px] font-semibold">{t("friends.activeNow")}</h3>
      {active.length === 0 ? (
        <p className="mt-6 text-center text-[14px] leading-relaxed text-fg-3">{t("friends.quiet")}</p>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          {active.map((r) => {
            const vs = voice[r.userId];
            const ch = vs?.channelId ? s.channels[vs.channelId] : undefined;
            return (
              <button
                key={r.userId}
                onClick={() => (ch ? navigate(ch.guildId ?? "@me", ch.id) : useUI.getState().setModal({ kind: "profile", userId: r.userId }))}
                className="rounded-2xl bg-raised/60 p-3.5 text-left hairline transition-colors hover:bg-raised"
              >
                <div className="flex items-center gap-3">
                  <UserAvatar userId={r.userId} size={36} statusRing="ring-raised" />
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{displayName(s, r.userId)}</div>
                    <div className="truncate text-[12.5px] text-fg-3">{activityText(presences[r.userId]) ?? ""}</div>
                  </div>
                </div>
                {ch && (
                  <div className="mt-3 flex items-center gap-2 rounded-xl bg-canvas/60 px-3 py-2 text-[13px] text-fg-2">
                    <Volume2 size={15} className="text-ok" />
                    <span className="truncate">{channelTitle(s, ch)}</span>
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </aside>
  );
}
