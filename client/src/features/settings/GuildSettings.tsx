import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import clsx from "clsx";
import { ArrowDown, ArrowUp, Plus, Upload, Trash2, Search, Crown, ShieldBan } from "lucide-react";
import {
  PERMISSION_GROUPS,
  Permission,
  hexToColor,
  colorToHex,
  parsePerms,
  type AuditEntryDTO,
  type BanDTO,
  type InviteDTO,
  type PermissionName,
  type RoleDTO,
} from "@nova/shared";
import { api, uploadEmoji, uploadImage } from "../../lib/api";
import { errorText, t } from "../../lib/i18n";
import { toast } from "../../lib/bus";
import { fmtDate, fmtDateTime, fmtRelative } from "../../lib/time";
import { mediaUrl } from "../../lib/server";
import { can, displayName, guildPerms, useData } from "../../store/data";
import { confirmDialog, navigate } from "../../store/ui";
import { Button, Input, Textarea, Switch, Field } from "../../components/ui/primitives";
import { GuildIcon, UserAvatar } from "../../components/ui/avatar";
import { useContextMenu } from "../../components/ui/overlay";
import { userMenu } from "../shell/menus";
import { PermLabel } from "../modals/ChannelSettings";
import { inviteLink } from "../modals/basic";
import { SettingsLayout, SectionTitle } from "./SettingsLayout";

type Tab = "overview" | "roles" | "emoji" | "members" | "invites" | "bans" | "audit";

export default function GuildSettings({ guildId, tab: initial, onClose }: { guildId: string; tab?: string; onClose: () => void }) {
  const guild = useData((s) => s.guilds[guildId]);
  const bits = useData((s) => guildPerms(s, guildId));
  const me = useData((s) => s.me?.id);
  const [tab, setTab] = useState<Tab | null>((initial as Tab) ?? (window.innerWidth < 768 ? null : "overview"));
  if (!guild) return null;
  const owner = guild.ownerId === me;
  const items = [
    can(bits, Permission.MANAGE_GUILD) && { id: "overview", label: t("serverSettings.overview") },
    can(bits, Permission.MANAGE_ROLES) && { id: "roles", label: t("serverSettings.roles") },
    can(bits, Permission.MANAGE_EMOJIS) && { id: "emoji", label: t("serverSettings.emoji") },
    { id: "members", label: t("serverSettings.members") },
    can(bits, Permission.MANAGE_GUILD) && { id: "invites", label: t("serverSettings.invites") },
    can(bits, Permission.BAN_MEMBERS) && { id: "bans", label: t("serverSettings.bans") },
    can(bits, Permission.VIEW_AUDIT_LOG) && { id: "audit", label: t("serverSettings.audit") },
  ].filter(Boolean) as { id: string; label: string }[];
  const sections = [
    { title: guild.name, items },
    ...(owner
      ? [
          {
            items: [
              {
                id: "delete",
                label: t("guild.delete"),
                danger: true,
                onClick: () =>
                  confirmDialog({
                    title: t("guild.delete"),
                    body: t("guild.deleteConfirm", { name: guild.name }),
                    danger: true,
                    confirmLabel: t("common.delete"),
                    typeToConfirm: guild.name,
                    onConfirm: async () => {
                      await api(`/api/guilds/${guildId}`, { method: "DELETE" });
                      onClose();
                      navigate("@me");
                    },
                  }),
              },
            ],
          },
        ]
      : []),
  ];
  return (
    <SettingsLayout sections={sections} active={tab} onSelect={(id) => setTab(id as Tab | null)} onClose={onClose}>
      {tab === "overview" && <Overview guildId={guildId} />}
      {tab === "roles" && <Roles guildId={guildId} />}
      {tab === "emoji" && <Emojis guildId={guildId} />}
      {tab === "members" && <Members guildId={guildId} />}
      {tab === "invites" && <Invites guildId={guildId} />}
      {tab === "bans" && <Bans guildId={guildId} />}
      {tab === "audit" && <Audit guildId={guildId} />}
    </SettingsLayout>
  );
}

function pickImage(kind: "icon" | "guild_banner", done: (url: string) => void) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    try {
      done((await uploadImage(f, kind)).url);
    } catch (e) {
      toast(errorText(e), "error");
    }
  };
  input.click();
}

function Overview({ guildId }: { guildId: string }) {
  const g = useData((s) => s.guilds[guildId])!;
  const me = useData((s) => s.me?.id);
  const textChannels = useData(useShallow((s) => Object.values(s.channels).filter((c) => c.guildId === guildId && c.type === "text")));
  const members = useData(useShallow((s) => Object.keys(s.members[guildId] ?? {})));
  const [form, setForm] = useState({ name: g.name, description: g.description ?? "", icon: g.icon, banner: g.banner, systemChannelId: g.systemChannelId });
  const [busy, setBusy] = useState(false);
  const [newOwner, setNewOwner] = useState("");
  const dirty = form.name !== g.name || form.description !== (g.description ?? "") || form.icon !== g.icon || form.banner !== g.banner || form.systemChannelId !== g.systemChannelId;
  const save = async () => {
    setBusy(true);
    try {
      await api(`/api/guilds/${guildId}`, { method: "PATCH", body: { ...form, description: form.description || null } });
      toast(t("common.saved"), "success");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const s = useData.getState();
  return (
    <>
      <SectionTitle>{t("serverSettings.overview")}</SectionTitle>
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-5">
          <button onClick={() => pickImage("icon", (u) => setForm({ ...form, icon: u }))} className="group relative">
            <GuildIcon guildId={guildId} name={form.name} icon={form.icon} size={96} active />
            <span className="absolute inset-0 flex items-center justify-center rounded-[32%] bg-canvas/60 opacity-0 transition-opacity group-hover:opacity-100">
              <Upload size={22} />
            </span>
          </button>
          <Input label={t("guild.name")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={100} className="flex-1" />
        </div>
        <Field label={t("settings.banner")}>
          <button onClick={() => pickImage("guild_banner", (u) => setForm({ ...form, banner: u }))} className="relative flex h-36 w-full max-w-md items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed border-line/20 text-fg-3 hover:border-star/60">
            {form.banner ? <img src={mediaUrl(form.banner, 480)} alt="" className="h-full w-full object-cover" /> : <Upload size={24} />}
          </button>
          {form.banner && (
            <button onClick={() => setForm({ ...form, banner: null })} className="self-start text-[13px] text-bad hover:underline">
              {t("common.remove")}
            </button>
          )}
        </Field>
        <Textarea label={t("serverSettings.description")} hint={t("serverSettings.descriptionHint")} value={form.description} maxLength={500} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <Field label={t("serverSettings.systemChannel")}>
          <select value={form.systemChannelId ?? ""} onChange={(e) => setForm({ ...form, systemChannelId: e.target.value || null })} className="h-10 rounded-lg bg-canvas/70 px-3 outline-none ring-1 ring-line/10">
            <option value="">{t("serverSettings.systemChannelNone")}</option>
            {textChannels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
        </Field>
        {g.ownerId === me && (
          <Field label={t("serverSettings.transfer")}>
            <div className="flex gap-2">
              <select value={newOwner} onChange={(e) => setNewOwner(e.target.value)} className="h-10 flex-1 rounded-lg bg-canvas/70 px-3 outline-none ring-1 ring-line/10">
                <option value="">—</option>
                {members
                  .filter((u) => u !== me)
                  .map((u) => (
                    <option key={u} value={u}>
                      {displayName(s, u, guildId)}
                    </option>
                  ))}
              </select>
              <Button
                variant="danger"
                disabled={!newOwner}
                onClick={() =>
                  confirmDialog({
                    title: t("serverSettings.transfer"),
                    body: t("serverSettings.transferConfirm", { name: displayName(s, newOwner, guildId) }),
                    danger: true,
                    onConfirm: () => api(`/api/guilds/${guildId}/transfer`, { method: "POST", body: { userId: newOwner } }),
                  })
                }
              >
                {t("serverSettings.transfer")}
              </Button>
            </div>
          </Field>
        )}
      </div>
      {dirty && (
        <div className="sticky bottom-4 mt-6 flex items-center justify-between rounded-xl bg-canvas p-3 shadow-lift anim-pop">
          <span className="text-[14px]">{t("common.unsavedChanges")}</span>
          <Button size="sm" variant="success" loading={busy} onClick={() => void save()}>
            {t("common.save")}
          </Button>
        </div>
      )}
    </>
  );
}

const ROLE_COLORS = [0, 0x1abc9c, 0x2ecc71, 0x3498db, 0x9b59b6, 0xe91e63, 0xf1c40f, 0xe67e22, 0xe74c3c, 0x95a5a6, 0xffc35c, 0x7a98ff];

function Roles({ guildId }: { guildId: string }) {
  const roles = useData(useShallow((s) => Object.values(s.roles[guildId] ?? {}).sort((a, b) => b.position - a.position)));
  const [sel, setSel] = useState<string>(guildId);
  const role = roles.find((r) => r.id === sel) ?? roles.find((r) => r.id === guildId);
  const create = async () => {
    try {
      const r = await api<RoleDTO>(`/api/guilds/${guildId}/roles`, { method: "POST", body: { name: t("serverSettings.newRole") } });
      setSel(r.id);
    } catch (e) {
      toast(errorText(e), "error");
    }
  };
  const move = async (r: RoleDTO, dir: 1 | -1) => {
    const ordered = roles.filter((x) => x.id !== guildId).sort((a, b) => a.position - b.position);
    const i = ordered.findIndex((x) => x.id === r.id);
    const j = i + dir;
    if (j < 0 || j >= ordered.length) return;
    const positions = [
      { id: ordered[i].id, position: ordered[j].position },
      { id: ordered[j].id, position: ordered[i].position },
    ];
    await api(`/api/guilds/${guildId}/roles`, { method: "PATCH", body: positions }).catch((e) => toast(errorText(e), "error"));
  };
  return (
    <>
      <SectionTitle sub={t("serverSettings.dragToReorder")}>{t("serverSettings.roles")}</SectionTitle>
      <div className="grid gap-6 md:grid-cols-[220px_1fr]">
        <div className="flex flex-col gap-1">
          <Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={() => void create()} className="mb-2">
            {t("serverSettings.newRole")}
          </Button>
          {roles.map((r) => (
            <div key={r.id} className={clsx("group flex items-center gap-2 rounded-lg px-2 py-1.5", sel === r.id ? "bg-raised" : "hover:bg-raised/50")}>
              <button onClick={() => setSel(r.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left text-[14.5px]">
                <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: r.color ? colorToHex(r.color)! : "rgb(var(--fg-3))" }} />
                <span className="truncate">{r.id === guildId ? "@everyone" : r.name}</span>
              </button>
              {r.id !== guildId && (
                <span className="flex opacity-0 group-hover:opacity-100">
                  <button onClick={() => void move(r, 1)} className="p-0.5 text-fg-3 hover:text-fg" aria-label={t("common.moveUp")}>
                    <ArrowUp size={14} />
                  </button>
                  <button onClick={() => void move(r, -1)} className="p-0.5 text-fg-3 hover:text-fg" aria-label={t("common.moveDown")}>
                    <ArrowDown size={14} />
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>
        {role && <RoleEditor key={role.id} guildId={guildId} role={role} />}
      </div>
    </>
  );
}

function RoleEditor({ guildId, role }: { guildId: string; role: RoleDTO }) {
  const everyone = role.id === guildId;
  const [form, setForm] = useState({ name: role.name, color: role.color, hoist: role.hoist, mentionable: role.mentionable, permissions: role.permissions });
  const [busy, setBusy] = useState(false);
  const holders = useData(useShallow((s) => Object.values(s.members[guildId] ?? {}).filter((m) => m.roles.includes(role.id)).map((m) => m.userId)));
  const dirty = form.name !== role.name || form.color !== role.color || form.hoist !== role.hoist || form.mentionable !== role.mentionable || form.permissions !== role.permissions;
  const bits = parsePerms(form.permissions);
  const toggle = (p: PermissionName, on: boolean) => setForm({ ...form, permissions: (on ? bits | Permission[p] : bits & ~Permission[p]).toString() });
  const save = async () => {
    setBusy(true);
    try {
      await api(`/api/guilds/${guildId}/roles/${role.id}`, { method: "PATCH", body: everyone ? { permissions: form.permissions } : form });
      toast(t("common.saved"), "success");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const s = useData.getState();
  return (
    <div>
      {everyone ? (
        <p className="mb-4 text-[14px] text-fg-2">{t("serverSettings.everyoneHint")}</p>
      ) : (
        <div className="mb-6 flex flex-col gap-4">
          <Input label={t("serverSettings.roleName")} value={form.name} maxLength={100} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Field label={t("serverSettings.roleColor")}>
            <div className="flex flex-wrap items-center gap-2">
              {ROLE_COLORS.map((c) => (
                <button key={c} onClick={() => setForm({ ...form, color: c })} className={clsx("h-8 w-8 rounded-lg ring-2 ring-offset-2 ring-offset-surface", form.color === c ? "ring-fg" : "ring-transparent")} style={{ background: c ? colorToHex(c)! : "rgb(var(--fg-3))" }} aria-label={String(c)} />
              ))}
              <input type="color" value={colorToHex(form.color) ?? "#99aab5"} onChange={(e) => setForm({ ...form, color: hexToColor(e.target.value) })} className="h-8 w-10 cursor-pointer rounded-lg bg-transparent" />
            </div>
          </Field>
          <div className="flex items-center justify-between">
            <span>{t("serverSettings.roleHoist")}</span>
            <Switch checked={form.hoist} onChange={(v) => setForm({ ...form, hoist: v })} />
          </div>
          <div className="flex items-center justify-between">
            <span>{t("serverSettings.roleMentionable")}</span>
            <Switch checked={form.mentionable} onChange={(v) => setForm({ ...form, mentionable: v })} />
          </div>
        </div>
      )}
      <h3 className="mb-2 font-display text-[16px] font-semibold">{t("serverSettings.rolePerms")}</h3>
      {PERMISSION_GROUPS.map((g) => (
        <section key={g.key} className="mb-5">
          <h4 className="mb-1 text-[12.5px] font-semibold text-fg-3">{t(`perm.groups.${g.key}`)}</h4>
          {g.perms.map((p) => (
            <div key={p} className="flex items-center justify-between gap-4 border-b border-line/8 py-2.5">
              <PermLabel name={p} />
              <Switch checked={(bits & Permission[p]) === Permission[p]} onChange={(v) => toggle(p, v)} />
            </div>
          ))}
        </section>
      ))}
      {!everyone && (
        <>
          <h3 className="mb-2 font-display text-[16px] font-semibold">{t("serverSettings.roleMembers", { n: holders.length })}</h3>
          <div className="mb-6 flex flex-wrap gap-2">
            {holders.map((u) => (
              <span key={u} className="flex items-center gap-2 rounded-full bg-raised py-1 pl-1 pr-3 text-[13.5px]">
                <UserAvatar userId={u} size={22} showStatus={false} />
                {displayName(s, u, guildId)}
              </span>
            ))}
          </div>
          <Button
            variant="danger"
            icon={<Trash2 size={14} />}
            onClick={() =>
              confirmDialog({
                title: t("serverSettings.roleDelete"),
                body: t("serverSettings.roleDeleteConfirm", { name: role.name }),
                danger: true,
                onConfirm: () => api(`/api/guilds/${guildId}/roles/${role.id}`, { method: "DELETE" }),
              })
            }
          >
            {t("serverSettings.roleDelete")}
          </Button>
        </>
      )}
      {dirty && (
        <div className="sticky bottom-4 mt-6 flex items-center justify-between rounded-xl bg-canvas p-3 shadow-lift anim-pop">
          <span className="text-[14px]">{t("common.unsavedChanges")}</span>
          <Button size="sm" variant="success" loading={busy} onClick={() => void save()}>
            {t("common.save")}
          </Button>
        </div>
      )}
    </div>
  );
}

function Emojis({ guildId }: { guildId: string }) {
  const emojis = useData((s) => s.emojis[guildId] ?? []);
  const [name, setName] = useState("");
  const upload = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/gif,image/webp,image/jpeg";
    input.multiple = true;
    input.onchange = async () => {
      for (const f of [...(input.files ?? [])]) {
        const n = (name || f.name.replace(/\.[^.]+$/, "")).replace(/[^A-Za-z0-9_]/g, "_").slice(0, 32);
        try {
          await uploadEmoji(guildId, f, n.length >= 2 ? n : `emoji_${n}`);
        } catch (e) {
          toast(errorText(e), "error");
        }
      }
      setName("");
    };
    input.click();
  };
  return (
    <>
      <SectionTitle sub={t("serverSettings.emojiHint")}>{t("serverSettings.emoji")}</SectionTitle>
      <div className="mb-6 flex gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("serverSettings.emojiNamePlaceholder")} className="max-w-xs" />
        <Button icon={<Upload size={15} />} onClick={upload}>
          {t("serverSettings.uploadEmoji")}
        </Button>
      </div>
      <div className="mb-2 text-[13px] font-semibold text-fg-3">{t("serverSettings.emojiCount", { n: emojis.length })}</div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {emojis.map((e) => (
          <div key={e.id} className="group flex items-center gap-3 rounded-xl bg-panel p-2.5 hairline">
            <img src={mediaUrl(e.url, 48)} alt="" className="h-9 w-9 object-contain" />
            <span className="min-w-0 flex-1 truncate font-mono text-[13.5px]">:{e.name}:</span>
            <button onClick={() => void api(`/api/guilds/${guildId}/emojis/${e.id}`, { method: "DELETE" })} className="rounded-lg p-1.5 text-fg-3 opacity-0 hover:text-bad group-hover:opacity-100" aria-label={t("common.delete")}>
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

function Members({ guildId }: { guildId: string }) {
  const members = useData(useShallow((s) => Object.values(s.members[guildId] ?? {})));
  const roles = useData((s) => s.roles[guildId] ?? {});
  const owner = useData((s) => s.guilds[guildId]?.ownerId);
  const [q, setQ] = useState("");
  const menu = useContextMenu();
  const s = useData.getState();
  const list = useMemo(
    () => members.filter((m) => !q || displayName(s, m.userId, guildId).toLowerCase().includes(q.toLowerCase()) || s.users[m.userId]?.username.includes(q.toLowerCase())).slice(0, 300),
    [members, q, s, guildId]
  );
  return (
    <>
      <SectionTitle>{t("serverSettings.members")}</SectionTitle>
      <div className="relative mb-4">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-3" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("serverSettings.memberSearch")} className="h-10 w-full rounded-xl bg-canvas/70 pl-9 pr-3 outline-none ring-1 ring-line/10 focus:ring-star/60" />
      </div>
      <div className="flex flex-col">
        {list.map((m) => (
          <div key={m.userId} onContextMenu={(e) => menu(e, userMenu(m.userId, guildId))} className="flex items-center gap-3 border-b border-line/8 py-2.5">
            <UserAvatar userId={m.userId} size={36} statusRing="ring-surface" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 font-semibold">
                {displayName(s, m.userId, guildId)}
                {owner === m.userId && <Crown size={13} className="text-warn" />}
              </div>
              <div className="text-[12.5px] text-fg-3">
                @{s.users[m.userId]?.username} · {t("serverSettings.joined")} {fmtDate(m.joinedAt)}
              </div>
            </div>
            <div className="hidden max-w-[40%] flex-wrap justify-end gap-1 md:flex">
              {m.roles.slice(0, 4).map((r) =>
                roles[r] ? (
                  <span key={r} className="flex items-center gap-1 rounded-md bg-raised px-1.5 py-0.5 text-[12px]">
                    <span className="h-2 w-2 rounded-full" style={{ background: roles[r].color ? colorToHex(roles[r].color)! : "rgb(var(--fg-3))" }} />
                    {roles[r].name}
                  </span>
                ) : null
              )}
            </div>
            <button onClick={(e) => menu(e.currentTarget.getBoundingClientRect(), userMenu(m.userId, guildId))} className="rounded-lg px-2 py-1 text-fg-3 hover:bg-raised hover:text-fg">
              ⋯
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

function Invites({ guildId }: { guildId: string }) {
  const [list, setList] = useState<InviteDTO[] | null>(null);
  const load = () => void api<InviteDTO[]>(`/api/guilds/${guildId}/invites`).then(setList).catch(() => setList([]));
  useEffect(load, [guildId]);
  return (
    <>
      <SectionTitle>{t("serverSettings.invites")}</SectionTitle>
      {list && !list.length && <p className="text-fg-3">{t("serverSettings.noInvites")}</p>}
      <div className="flex flex-col gap-2">
        {list?.map((i) => (
          <div key={i.code} className="flex items-center gap-3 rounded-xl bg-panel p-3 hairline">
            {i.inviter && <UserAvatar userId={i.inviter.id} size={30} showStatus={false} />}
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-[13.5px]">{inviteLink(i.code)}</div>
              <div className="text-[12.5px] text-fg-3">
                {t("serverSettings.uses")}: {i.uses}
                {i.maxUses ? `/${i.maxUses}` : ""} · {t("serverSettings.expires")}: {i.expiresAt ? fmtDateTime(i.expiresAt) : t("serverSettings.never")}
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                await api(`/api/invites/${i.code}`, { method: "DELETE" }).catch((e) => toast(errorText(e), "error"));
                load();
              }}
            >
              {t("serverSettings.revoke")}
            </Button>
          </div>
        ))}
      </div>
    </>
  );
}

function Bans({ guildId }: { guildId: string }) {
  const [list, setList] = useState<BanDTO[] | null>(null);
  const load = () => void api<BanDTO[]>(`/api/guilds/${guildId}/bans`).then(setList).catch(() => setList([]));
  useEffect(load, [guildId]);
  return (
    <>
      <SectionTitle>{t("serverSettings.bans")}</SectionTitle>
      {list && !list.length && <p className="text-fg-3">{t("serverSettings.noBans")}</p>}
      <div className="flex flex-col gap-2">
        {list?.map((b) => (
          <div key={b.user.id} className="flex items-center gap-3 rounded-xl bg-panel p-3 hairline">
            <ShieldBan size={20} className="text-bad" />
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{b.user.displayName || b.user.username}</div>
              <div className="text-[12.5px] text-fg-3">{b.reason ?? "—"}</div>
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={async () => {
                await api(`/api/guilds/${guildId}/bans/${b.user.id}`, { method: "DELETE" }).catch((e) => toast(errorText(e), "error"));
                load();
              }}
            >
              {t("serverSettings.unban")}
            </Button>
          </div>
        ))}
      </div>
    </>
  );
}

function Audit({ guildId }: { guildId: string }) {
  const [list, setList] = useState<AuditEntryDTO[] | null>(null);
  useEffect(() => {
    api<AuditEntryDTO[]>(`/api/guilds/${guildId}/audit-log`).then(setList).catch(() => setList([]));
  }, [guildId]);
  const s = useData.getState();
  const target = (e: AuditEntryDTO) => {
    if (!e.targetId) return "";
    if (s.users[e.targetId]) return displayName(s, e.targetId, guildId);
    if (s.channels[e.targetId]) return `#${s.channels[e.targetId].name}`;
    return "";
  };
  return (
    <>
      <SectionTitle>{t("serverSettings.audit")}</SectionTitle>
      {list && !list.length && <p className="text-fg-3">{t("serverSettings.noAudit")}</p>}
      <div className="flex flex-col gap-2">
        {list?.map((e) => (
          <div key={e.id} className="flex items-start gap-3 rounded-xl bg-panel p-3 hairline">
            <UserAvatar userId={e.actorId} size={30} showStatus={false} />
            <div className="min-w-0 flex-1">
              <div className="text-[14px]">{t(`audit.${e.action}`, { actor: displayName(s, e.actorId, guildId), target: target(e) })}</div>
              {e.reason && <div className="text-[12.5px] text-fg-3">{t("audit.reason", { r: e.reason })}</div>}
              <div className="text-[12px] text-fg-3">{fmtRelative(e.createdAt)}</div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

