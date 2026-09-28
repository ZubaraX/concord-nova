// Instance administration — the "Nova server" section of user settings, shown
// only to instance admins. Everything here goes through /api/admin.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { Ban, Check, CircleCheck, Clock, Copy, Crown, Database, KeyRound, MessageSquare, Mic, MoreHorizontal, Paperclip, Radio, Search, Server, ShieldCheck, ShieldOff, TriangleAlert, Users } from "lucide-react";
import { formatBytes, type AdminGuildDTO, type AdminOverviewDTO, type AdminUserDTO, type RegistrationMode } from "@nova/shared";
import { api } from "../../lib/api";
import { errorText, getLocale, t } from "../../lib/i18n";
import { toast } from "../../lib/bus";
import { fmtDate, fmtDuration, fmtRelative } from "../../lib/time";
import { useDebounced } from "../../lib/hooks";
import { useData } from "../../store/data";
import { confirmDialog } from "../../store/ui";
import { settings } from "../../store/settings";
import { Button, IconButton, Input, Segmented, SettingRow, Spinner, useCopy } from "../../components/ui/primitives";
import { Avatar, GuildIcon } from "../../components/ui/avatar";
import { Modal, ModalFooter, ModalHeader, useContextMenu, type MenuEntry } from "../../components/ui/overlay";
import { Group, SectionTitle } from "./SettingsLayout";

const num = (n: number) => n.toLocaleString(getLocale());
const bytes = (s: string) => formatBytes(Number(s));
const nameOf = (u: { displayName: string | null; username: string }) => u.displayName || u.username;

function uptime(sec: number) {
  const d = Math.floor(sec / 86_400);
  return d ? `${t("time.days", { n: d })} ${t("time.hours", { n: Math.floor((sec % 86_400) / 3600) })}` : fmtDuration(sec);
}

function Badge({ tone, children }: { tone: "star" | "bad" | "warn" | "plain"; children: ReactNode }) {
  return (
    <span
      className={clsx(
        "shrink-0 rounded-md px-1.5 py-px text-[11px] font-semibold uppercase tracking-wide",
        tone === "star" && "bg-star/15 text-star",
        tone === "bad" && "bg-bad/15 text-bad",
        tone === "warn" && "bg-warn/15 text-warn",
        tone === "plain" && "bg-raised text-fg-2"
      )}
    >
      {children}
    </span>
  );
}

/** A list request whose late answers can't overwrite newer ones (fast typing). */
function useLatestList<T>(url: string, query: Record<string, string>) {
  const [list, setList] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const key = JSON.stringify(query);
  const load = useCallback(() => {
    const n = ++seq.current;
    return api<T[]>(url, { query: JSON.parse(key) as Record<string, string> }).then(
      (r) => {
        if (n !== seq.current) return;
        setList(r);
        setError(null);
      },
      (e) => {
        if (n === seq.current) setError(errorText(e));
      }
    );
  }, [url, key]);
  useEffect(() => void load(), [load]);
  return { list, error, reload: load };
}

// ── overview ─────────────────────────────────────────────────────────────────
export function AdminOverview() {
  const [data, setData] = useState<AdminOverviewDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    () =>
      api<AdminOverviewDTO>("/api/admin/overview").then(
        (d) => {
          setData(d);
          setError(null);
        },
        (e) => setError(errorText(e))
      ),
    []
  );
  useEffect(() => {
    void load();
    const id = setInterval(() => !document.hidden && void load(), 15_000);
    return () => clearInterval(id);
  }, [load]);

  if (!data)
    return (
      <>
        <SectionTitle>{t("admin.overview")}</SectionTitle>
        {error ? <p className="text-[14px] text-bad">{error}</p> : <Spinner />}
      </>
    );
  const cards: { icon: ReactNode; label: string; value: string; sub?: string }[] = [
    { icon: <Users size={16} />, label: t("admin.statUsers"), value: num(data.users), sub: t("admin.statUsersSub", { admins: data.admins, disabled: data.usersDisabled }) },
    { icon: <Radio size={16} />, label: t("admin.statOnline"), value: num(data.connected) },
    { icon: <Mic size={16} />, label: t("admin.statVoice"), value: num(data.voice.participants), sub: t("admin.statVoiceSub", { rooms: data.voice.rooms, calls: data.voice.calls }) },
    { icon: <Server size={16} />, label: t("admin.statServers"), value: num(data.guilds), sub: t("admin.statChannels", { n: data.channels }) },
    { icon: <MessageSquare size={16} />, label: t("admin.statMessages"), value: num(data.messages) },
    { icon: <Paperclip size={16} />, label: t("admin.statFiles"), value: bytes(data.storageBytes), sub: t("admin.statFilesSub", { n: data.attachments }) },
    { icon: <Database size={16} />, label: t("admin.statDatabase"), value: bytes(data.databaseBytes) },
    { icon: <Clock size={16} />, label: t("admin.statUptime"), value: uptime(data.uptimeSec), sub: `Nova ${data.version} · Node ${data.node.replace(/^v/, "")}` },
  ];
  return (
    <>
      <SectionTitle sub={t("admin.overviewHint")}>{t("admin.overview")}</SectionTitle>
      <div className="mb-8 grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="min-w-0 rounded-2xl bg-panel p-3.5 hairline">
            <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-fg-3">
              <span className="text-star">{c.icon}</span>
              <span className="truncate">{c.label}</span>
            </div>
            <div className="mt-1.5 truncate font-display text-[21px] font-semibold tabular-nums leading-tight">{c.value}</div>
            {c.sub && <div className="mt-0.5 text-[12px] leading-snug text-fg-3">{c.sub}</div>}
          </div>
        ))}
      </div>
      <InstanceSettings data={data} onChange={setData} />
    </>
  );
}

function InstanceSettings({ data, onChange }: { data: AdminOverviewDTO; onChange: (d: AdminOverviewDTO) => void }) {
  const [name, setName] = useState(data.serverName);
  const [busy, setBusy] = useState(false);
  const save = async (patch: { serverName?: string; registration?: RegistrationMode }) => {
    setBusy(true);
    try {
      const r = await api<{ serverName: string; registration: RegistrationMode }>("/api/admin/settings", { method: "PUT", body: patch });
      onChange({ ...data, ...r });
      setName(r.serverName);
      // The rest of this app (About, invites) reads the name from READY.
      useData.setState((s) => (s.server ? { server: { ...s.server, name: r.serverName, registration: r.registration } } : {}));
      toast(t("common.saved"), "success");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const dirty = name.trim() !== data.serverName && !!name.trim();
  return (
    <Group title={t("admin.instance")}>
      <SettingRow title={t("admin.serverName")} hint={t("admin.serverNameHint")}>
        <div className="flex w-full max-w-[340px] gap-2">
          <Input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && dirty && void save({ serverName: name.trim() })} />
          {dirty && (
            <Button loading={busy} onClick={() => void save({ serverName: name.trim() })} className="h-11">
              {t("common.save")}
            </Button>
          )}
        </div>
      </SettingRow>
      <SettingRow title={t("admin.registration")} hint={t(`admin.registrationHint.${data.registration}`)}>
        <Segmented<RegistrationMode>
          value={data.registration}
          onChange={(v) => v !== data.registration && void save({ registration: v })}
          options={[
            { value: "open", label: t("admin.registrationOpen") },
            { value: "invite", label: t("admin.registrationInvite") },
            { value: "closed", label: t("admin.registrationClosed") },
          ]}
        />
      </SettingRow>
    </Group>
  );
}

// ── users ────────────────────────────────────────────────────────────────────
function IssuedPassword({ issued, onClose }: { issued: { name: string; password: string } | null; onClose: () => void }) {
  const [copied, copy] = useCopy();
  return (
    <Modal open={!!issued} onClose={onClose} width={440} label={t("admin.newPasswordTitle")}>
      {issued && (
        <>
          <ModalHeader title={t("admin.newPasswordTitle")} subtitle={t("admin.newPasswordHint", { name: issued.name })} />
          <div className="px-6 pb-5 pt-2">
            <button
              onClick={() => copy(issued.password)}
              className="flex w-full items-center justify-between gap-3 rounded-xl bg-canvas/70 px-4 py-3 text-left ring-1 ring-line/10 transition-shadow hover:ring-star/50"
              aria-label={t("common.copy")}
            >
              <span className="select-all font-mono text-[19px] tracking-wider">{issued.password}</span>
              {copied ? <Check size={18} className="shrink-0 text-ok" /> : <Copy size={18} className="shrink-0 text-fg-3" />}
            </button>
            <p className="mt-3 text-[13px] leading-snug text-fg-3">{t("admin.newPasswordNote")}</p>
          </div>
          <ModalFooter>
            <Button onClick={onClose}>{t("common.done")}</Button>
          </ModalFooter>
        </>
      )}
    </Modal>
  );
}

export function AdminUsers() {
  const meId = useData((s) => s.me!.id);
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim(), 250);
  const { list, error, reload } = useLatestList<AdminUserDTO>("/api/admin/users", { q: dq });
  const [issued, setIssued] = useState<{ name: string; password: string } | null>(null);
  const menu = useContextMenu();

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      if (done) toast(done, "success");
    } catch (e) {
      toast(errorText(e), "error");
    }
    void reload();
  };
  const post = (u: AdminUserDTO, what: "disabled" | "admin", value: boolean) => api(`/api/admin/users/${u.id}/${what}`, { method: "POST", body: { value } });
  const issuePassword = async (u: AdminUserDTO) => {
    const r = await api<{ password: string }>(`/api/admin/users/${u.id}/password`, { method: "POST" });
    setIssued({ name: nameOf(u), password: r.password });
  };

  const items = (u: AdminUserDTO): MenuEntry[] => {
    const self = u.id === meId;
    const name = nameOf(u);
    return [
      {
        label: t("admin.resetPassword"),
        icon: <KeyRound size={16} />,
        onSelect: () =>
          confirmDialog({
            title: t("admin.resetPasswordTitle", { name }),
            body: self ? t("admin.resetPasswordSelf") : t("admin.resetPasswordBody"),
            confirmLabel: t("admin.resetPassword"),
            onConfirm: () => run(() => issuePassword(u)),
          }),
      },
      !self &&
        (u.admin
          ? {
              label: t("admin.revokeAdmin"),
              icon: <ShieldOff size={16} />,
              onSelect: () =>
                confirmDialog({ title: t("admin.revokeAdminTitle", { name }), body: t("admin.revokeAdminBody"), confirmLabel: t("admin.revokeAdmin"), danger: true, onConfirm: () => run(() => post(u, "admin", false), t("common.saved")) }),
            }
          : {
              label: t("admin.grantAdmin"),
              icon: <ShieldCheck size={16} />,
              onSelect: () =>
                confirmDialog({ title: t("admin.grantAdminTitle", { name }), body: t("admin.grantAdminBody"), confirmLabel: t("admin.grantAdmin"), onConfirm: () => run(() => post(u, "admin", true), t("common.saved")) }),
            }),
      !self && { separator: true },
      !self &&
        (u.disabled
          ? {
              label: u.passwordLocked ? t("admin.enableWithPassword") : t("admin.enable"),
              icon: <CircleCheck size={16} />,
              onSelect: () => {
                if (!u.passwordLocked) return void run(() => post(u, "disabled", false), t("admin.enabled"));
                // A password locked for being public must be replaced before anyone can sign in.
                confirmDialog({
                  title: t("admin.enableTitle", { name }),
                  body: t("admin.enableLockedBody"),
                  confirmLabel: t("admin.enableWithPassword"),
                  onConfirm: () =>
                    run(async () => {
                      await post(u, "disabled", false);
                      await issuePassword(u);
                    }),
                });
              },
            }
          : {
              label: t("admin.disable"),
              icon: <Ban size={16} />,
              danger: true,
              onSelect: () =>
                confirmDialog({ title: t("admin.disableTitle", { name }), body: t("admin.disableBody"), confirmLabel: t("admin.disable"), danger: true, onConfirm: () => run(() => post(u, "disabled", true), t("admin.disabled")) }),
            }),
      settings().developerMode && { separator: true },
      settings().developerMode && { label: t("chat.menu.copyId"), icon: <Copy size={16} />, onSelect: () => void navigator.clipboard?.writeText(u.id).then(() => toast(t("common.copied"), "success")) },
    ];
  };

  return (
    <>
      <SectionTitle sub={t("admin.usersHint")}>{t("admin.users")}</SectionTitle>
      <div className="relative mb-3">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-3" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("admin.userSearch")}
          className="h-10 w-full rounded-xl bg-canvas/70 pl-9 pr-3 outline-none ring-1 ring-line/10 focus:ring-star/60"
        />
      </div>
      {error && <p className="mb-3 text-[14px] text-bad">{error}</p>}
      {!list && !error && <Spinner />}
      {list && !list.length && <p className="py-6 text-center text-[14px] text-fg-3">{t("admin.noUsers")}</p>}
      <div className="flex flex-col" data-admin-users>
        {list?.map((u) => (
          <div key={u.id} data-user={u.username} onContextMenu={(e) => menu(e, items(u))} className="flex items-center gap-3 border-b border-line/8 py-2.5">
            <Avatar userId={u.id} src={u.avatar} name={nameOf(u)} size={38} className={clsx(u.disabled && "opacity-45 grayscale")} />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
                <span className={clsx("truncate font-semibold", u.disabled && "text-fg-3 line-through decoration-fg-3/60")}>{nameOf(u)}</span>
                {u.id === meId && <Badge tone="plain">{t("common.you")}</Badge>}
                {u.admin && <Badge tone="star">{t("admin.badgeAdmin")}</Badge>}
                {u.disabled && <Badge tone="bad">{t("admin.badgeDisabled")}</Badge>}
                {u.passwordLocked && <Badge tone="warn">{t("admin.badgeLocked")}</Badge>}
              </div>
              <div className="text-[12.5px] text-fg-3 [overflow-wrap:anywhere]">
                @{u.username} · {u.email}
              </div>
              <div className="text-[12px] leading-snug text-fg-3">
                {t("admin.userMeta", { created: fmtDate(u.createdAt), active: u.lastActiveAt ? fmtRelative(u.lastActiveAt) : t("admin.never"), n: u.guilds })}
              </div>
            </div>
            <IconButton label={t("common.more")} onClick={(e) => menu(e.currentTarget.getBoundingClientRect(), items(u))}>
              <MoreHorizontal size={18} />
            </IconButton>
          </div>
        ))}
      </div>
      {list && list.length >= 200 && <p className="mt-3 text-center text-[13px] text-fg-3">{t("admin.narrowSearch")}</p>}
      <IssuedPassword issued={issued} onClose={() => setIssued(null)} />
    </>
  );
}

// ── servers ──────────────────────────────────────────────────────────────────
export function AdminGuilds() {
  const { list, error, reload } = useLatestList<AdminGuildDTO>("/api/admin/guilds", {});
  const [q, setQ] = useState("");
  const [transfer, setTransfer] = useState<AdminGuildDTO | null>(null);
  const needle = q.trim().toLowerCase();
  const shown = (list ?? [])
    .filter((g) => !needle || g.name.toLowerCase().includes(needle) || g.ownerName.toLowerCase().includes(needle))
    .sort((a, b) => Number(b.ownerDisabled) - Number(a.ownerDisabled));
  const orphaned = list?.filter((g) => g.ownerDisabled).length ?? 0;
  return (
    <>
      <SectionTitle sub={t("admin.guildsHint")}>{t("admin.guilds")}</SectionTitle>
      {orphaned > 0 && (
        <div className="mb-4 flex items-start gap-2.5 rounded-xl bg-warn/10 px-4 py-3 text-[13.5px] leading-snug ring-1 ring-warn/30">
          <TriangleAlert size={17} className="mt-px shrink-0 text-warn" />
          <span>{t("admin.orphaned", { n: orphaned })}</span>
        </div>
      )}
      {(list?.length ?? 0) > 6 && (
        <div className="relative mb-3">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-3" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("admin.guildSearch")} className="h-10 w-full rounded-xl bg-canvas/70 pl-9 pr-3 outline-none ring-1 ring-line/10 focus:ring-star/60" />
        </div>
      )}
      {error && <p className="mb-3 text-[14px] text-bad">{error}</p>}
      {!list && !error && <Spinner />}
      {list && !list.length && <p className="py-6 text-center text-[14px] text-fg-3">{t("admin.noGuilds")}</p>}
      <div className="flex flex-col" data-admin-guilds>
        {shown.map((g) => (
          <div key={g.id} data-guild={g.name} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line/8 py-2.5">
            <GuildIcon guildId={g.id} name={g.name} icon={g.icon} size={40} active />
            <div className="min-w-0 flex-1 basis-40">
              <div className="truncate font-semibold">{g.name}</div>
              <div className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-fg-3">
                <Crown size={12} className="shrink-0 text-warn" />
                <span className="truncate">{g.ownerName}</span>
                {g.ownerDisabled && <Badge tone="bad">{t("admin.badgeDisabled")}</Badge>}
              </div>
              <div className="truncate text-[12px] text-fg-3">{t("admin.guildMeta", { n: g.members, created: fmtDate(g.createdAt) })}</div>
            </div>
            <Button size="sm" variant={g.ownerDisabled ? "primary" : "secondary"} onClick={() => setTransfer(g)} className="max-sm:ml-[52px]">
              {t("admin.changeOwner")}
            </Button>
          </div>
        ))}
      </div>
      <TransferOwner guild={transfer} onClose={() => setTransfer(null)} onDone={() => void reload()} />
    </>
  );
}

function TransferOwner({ guild, onClose, onDone }: { guild: AdminGuildDTO | null; onClose: () => void; onDone: () => void }) {
  return (
    <Modal open={!!guild} onClose={onClose} width={480} label={t("admin.changeOwner")}>
      {guild && <TransferBody key={guild.id} guild={guild} onClose={onClose} onDone={onDone} />}
    </Modal>
  );
}

function TransferBody({ guild, onClose, onDone }: { guild: AdminGuildDTO; onClose: () => void; onDone: () => void }) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim(), 250);
  const { list, error } = useLatestList<AdminUserDTO>("/api/admin/users", { q: dq, guild: guild.id });
  const [pick, setPick] = useState<AdminUserDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const candidates = (list ?? []).filter((u) => u.id !== guild.ownerId && !u.disabled);
  const submit = async () => {
    if (!pick) return;
    setBusy(true);
    try {
      await api(`/api/admin/guilds/${guild.id}/owner`, { method: "POST", body: { userId: pick.id } });
      toast(t("admin.ownerChanged", { guild: guild.name, name: nameOf(pick) }), "success");
      onDone();
      onClose();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <ModalHeader title={t("admin.changeOwnerTitle", { guild: guild.name })} subtitle={t("admin.changeOwnerHint", { name: guild.ownerName })} />
      <div className="px-6 pb-4 pt-2">
        <div className="relative mb-2">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-3" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("admin.memberSearch")}
            className="h-10 w-full rounded-xl bg-canvas/70 pl-9 pr-3 outline-none ring-1 ring-line/10 focus:ring-star/60"
          />
        </div>
        <div className="scroll-thin -mx-2 h-[min(300px,40vh)] overflow-y-auto px-1">
          {error && <p className="p-2 text-[14px] text-bad">{error}</p>}
          {!list && !error && <Spinner className="m-2" />}
          {list && !candidates.length && <p className="p-3 text-center text-[13.5px] text-fg-3">{t("admin.noCandidates")}</p>}
          {candidates.map((u) => (
            <button
              key={u.id}
              onClick={() => setPick(u)}
              className={clsx("flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors", pick?.id === u.id ? "bg-star/15 ring-1 ring-star/60" : "hover:bg-raised")}
            >
              <Avatar userId={u.id} src={u.avatar} name={nameOf(u)} size={32} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{nameOf(u)}</span>
                <span className="block truncate text-[12.5px] text-fg-3">@{u.username}</span>
              </span>
              {pick?.id === u.id && <Check size={18} className="shrink-0 text-star" />}
            </button>
          ))}
        </div>
      </div>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button disabled={!pick} loading={busy} onClick={() => void submit()}>
          {t("admin.transfer")}
        </Button>
      </ModalFooter>
    </>
  );
}
