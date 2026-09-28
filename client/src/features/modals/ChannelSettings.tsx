import { useMemo, useState } from "react";
import clsx from "clsx";
import { Check, X, Slash, Plus, Trash2 } from "lucide-react";
import { PERMISSION_GROUPS, Permission, parsePerms, type ChannelDTO, type OverwriteDTO, type PermissionName } from "@nova/shared";
import { api } from "../../lib/api";
import { errorText, t, tr } from "../../lib/i18n";
import { toast } from "../../lib/bus";
import { displayName, useData } from "../../store/data";
import { confirmDialog } from "../../store/ui";
import { Modal } from "../../components/ui/overlay";
import { Button, Input, Textarea, Field } from "../../components/ui/primitives";
import { MenuList, Popover, usePopover } from "../../components/ui/overlay";
import { UserAvatar } from "../../components/ui/avatar";

const TEXT_ONLY: PermissionName[] = ["SEND_MESSAGES", "SEND_MESSAGES_IN_THREADS", "CREATE_THREADS", "EMBED_LINKS", "ATTACH_FILES", "ADD_REACTIONS", "USE_EXTERNAL_EMOJIS", "MENTION_EVERYONE", "MANAGE_MESSAGES", "READ_MESSAGE_HISTORY", "SEND_VOICE_MESSAGES", "SEND_POLLS"];
const VOICE_ONLY: PermissionName[] = ["CONNECT", "SPEAK", "STREAM", "USE_VAD", "PRIORITY_SPEAKER", "MUTE_MEMBERS", "DEAFEN_MEMBERS", "MOVE_MEMBERS"];

export function permsForChannel(type: ChannelDTO["type"]): PermissionName[] {
  const base: PermissionName[] = ["VIEW_CHANNEL", "MANAGE_CHANNELS", "MANAGE_ROLES", "CREATE_INSTANT_INVITE"];
  if (type === "voice") return [...base, ...VOICE_ONLY, ...TEXT_ONLY];
  if (type === "category") return [...base, ...TEXT_ONLY, ...VOICE_ONLY];
  return [...base, ...TEXT_ONLY];
}

/** Tri-state switch used by every permission editor. */
export function TriState({ value, onChange }: { value: "allow" | "deny" | "inherit"; onChange: (v: "allow" | "deny" | "inherit") => void }) {
  const cell = "flex h-7 w-8 items-center justify-center transition-colors";
  return (
    <div className="flex overflow-hidden rounded-lg ring-1 ring-line/15">
      <button onClick={() => onChange("deny")} className={clsx(cell, value === "deny" ? "bg-bad text-white" : "text-fg-3 hover:bg-bad/15 hover:text-bad")} aria-label={t("perm.deny")} title={t("perm.deny")}>
        <X size={14} />
      </button>
      <button onClick={() => onChange("inherit")} className={clsx(cell, "border-x border-line/15", value === "inherit" ? "bg-overlay text-fg" : "text-fg-3 hover:bg-raised")} aria-label={t("perm.inherit")} title={t("perm.inherit")}>
        <Slash size={12} />
      </button>
      <button onClick={() => onChange("allow")} className={clsx(cell, value === "allow" ? "bg-ok text-[#04150d]" : "text-fg-3 hover:bg-ok/15 hover:text-ok")} aria-label={t("perm.allow")} title={t("perm.allow")}>
        <Check size={14} />
      </button>
    </div>
  );
}

export function PermLabel({ name }: { name: PermissionName }) {
  const [title, hint] = tr<[string, string]>(`perm.${name}`) ?? [name, ""];
  return (
    <div className="min-w-0">
      <div className="text-[14.5px] font-medium">{title}</div>
      {hint && <div className="text-[12.5px] text-fg-3">{hint}</div>}
    </div>
  );
}

export function ChannelSettingsModal({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const c = useData((s) => s.channels[channelId]);
  const [tab, setTab] = useState<"overview" | "perms">("overview");
  if (!c?.guildId) return null;
  return (
    <Modal open onClose={onClose} width={820} className="flex h-[min(680px,calc(100dvh-2rem))]">
      <nav className="flex w-52 shrink-0 flex-col gap-0.5 bg-panel p-3 max-sm:hidden">
        <div className="truncate px-2 pb-2 pt-1 text-[12px] font-semibold text-fg-3">#{c.name}</div>
        {(["overview", "perms"] as const).map((x) => (
          <button key={x} onClick={() => setTab(x)} className={clsx("rounded-lg px-2.5 py-2 text-left text-[14.5px] font-medium", tab === x ? "bg-raised text-fg" : "text-fg-2 hover:bg-raised/50")}>
            {x === "overview" ? t("channel.overview") : t("channel.permissions")}
          </button>
        ))}
        <div className="my-2 h-px bg-line/10" />
        <button
          onClick={() =>
            confirmDialog({
              title: t("channel.delete"),
              body: t("channel.deleteConfirm", { name: c.name }),
              danger: true,
              confirmLabel: t("common.delete"),
              onConfirm: async () => {
                await api(`/api/channels/${channelId}`, { method: "DELETE" });
                onClose();
              },
            })
          }
          className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[14.5px] font-medium text-bad hover:bg-bad/10"
        >
          <Trash2 size={15} /> {t("channel.delete")}
        </button>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">{tab === "overview" ? <Overview c={c} /> : <Overwrites c={c} />}</div>
    </Modal>
  );
}

function Overview({ c }: { c: ChannelDTO }) {
  const [name, setName] = useState(c.name);
  const [topic, setTopic] = useState(c.topic ?? "");
  const [slowmode, setSlowmode] = useState(c.slowmode);
  const [limit, setLimit] = useState(c.userLimit);
  const [bitrate, setBitrate] = useState(c.bitrate);
  const [busy, setBusy] = useState(false);
  const dirty = name !== c.name || topic !== (c.topic ?? "") || slowmode !== c.slowmode || limit !== c.userLimit || bitrate !== c.bitrate;
  const save = async () => {
    setBusy(true);
    try {
      await api(`/api/channels/${c.id}`, { method: "PATCH", body: { name, topic: topic || null, slowmode, userLimit: limit, bitrate } });
      toast(t("common.saved"), "success");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const SLOW = [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600];
  return (
    <>
      <div className="scroll-thin flex-1 overflow-y-auto p-6">
        <h2 className="mb-5 font-display text-[19px] font-semibold">{t("channel.overview")}</h2>
        <div className="flex max-w-lg flex-col gap-5">
          <Input label={t("channel.name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
          {c.type !== "category" && c.type !== "voice" && <Textarea label={t("channel.topic")} placeholder={t("channel.topicPlaceholder")} value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={1024} />}
          {c.type !== "category" && (
            <Field label={t("channel.slowmode")} hint={slowmode ? `${slowmode} с` : t("channel.slowmodeOff")}>
              <input type="range" min={0} max={SLOW.length - 1} value={Math.max(0, SLOW.indexOf(slowmode))} onChange={(e) => setSlowmode(SLOW[Number(e.target.value)])} className="accent-[rgb(var(--star))]" />
            </Field>
          )}
          {c.type === "voice" && (
            <>
              <Field label={t("channel.userLimit")} hint={limit ? String(limit) : t("channel.unlimited")}>
                <input type="range" min={0} max={99} value={limit} onChange={(e) => setLimit(Number(e.target.value))} className="accent-[rgb(var(--star))]" />
              </Field>
              <Field label={t("channel.bitrate")} hint={`${Math.round(bitrate / 1000)} kbps`}>
                <input type="range" min={8000} max={510000} step={8000} value={bitrate} onChange={(e) => setBitrate(Number(e.target.value))} className="accent-[rgb(var(--star))]" />
              </Field>
            </>
          )}
        </div>
      </div>
      {dirty && (
        <div className="m-4 flex items-center justify-between rounded-xl bg-canvas p-3 shadow-lift anim-pop">
          <span className="text-[14px]">{t("common.unsavedChanges")}</span>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setName(c.name);
                setTopic(c.topic ?? "");
                setSlowmode(c.slowmode);
                setLimit(c.userLimit);
                setBitrate(c.bitrate);
              }}
            >
              {t("common.reset")}
            </Button>
            <Button size="sm" variant="success" loading={busy} onClick={() => void save()}>
              {t("common.save")}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

function Overwrites({ c }: { c: ChannelDTO }) {
  const roles = useData((s) => s.roles[c.guildId!] ?? {});
  const members = useData((s) => s.members[c.guildId!] ?? {});
  const [list, setList] = useState<OverwriteDTO[]>(() => {
    const has = c.overwrites.some((o) => o.id === c.guildId);
    return has ? c.overwrites : [{ id: c.guildId!, type: "role", allow: "0", deny: "0" }, ...c.overwrites];
  });
  const [sel, setSel] = useState(c.guildId!);
  const [busy, setBusy] = useState(false);
  const add = usePopover();
  const perms = permsForChannel(c.type);
  const current = list.find((o) => o.id === sel);
  const s = useData.getState();

  const setBit = (name: PermissionName, v: "allow" | "deny" | "inherit") => {
    const bit = Permission[name];
    setList(
      list.map((o) => {
        if (o.id !== sel) return o;
        let allow = parsePerms(o.allow) & ~bit;
        let deny = parsePerms(o.deny) & ~bit;
        if (v === "allow") allow |= bit;
        if (v === "deny") deny |= bit;
        return { ...o, allow: allow.toString(), deny: deny.toString() };
      })
    );
  };
  const stateOf = (o: OverwriteDTO | undefined, name: PermissionName) => {
    const bit = Permission[name];
    if (!o) return "inherit";
    if (parsePerms(o.allow) & bit) return "allow";
    if (parsePerms(o.deny) & bit) return "deny";
    return "inherit";
  };
  const save = async () => {
    setBusy(true);
    try {
      await api(`/api/channels/${c.id}`, { method: "PATCH", body: { overwrites: list.filter((o) => o.allow !== "0" || o.deny !== "0" || o.id === c.guildId) } });
      toast(t("common.saved"), "success");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const label = (o: OverwriteDTO) => (o.type === "role" ? (o.id === c.guildId ? "@everyone" : roles[o.id]?.name ?? "?") : displayName(s, o.id, c.guildId));
  const groups = useMemo(() => PERMISSION_GROUPS.map((g) => ({ ...g, perms: g.perms.filter((p) => perms.includes(p)) })).filter((g) => g.perms.length), [perms]);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="scroll-thin w-52 shrink-0 overflow-y-auto border-r border-line/10 p-3">
        <div className="mb-2 flex items-center justify-between px-1">
          <span className="text-[12px] font-semibold text-fg-3">{t("serverSettings.roles")} / {t("common.members")}</span>
          <button onClick={add.toggle} className="rounded p-0.5 text-fg-3 hover:text-fg" aria-label={t("perm.addOverride")}>
            <Plus size={16} />
          </button>
        </div>
        {list.map((o) => (
          <button key={o.id} onClick={() => setSel(o.id)} className={clsx("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[14px]", sel === o.id ? "bg-raised text-fg" : "text-fg-2 hover:bg-raised/50")}>
            {o.type === "member" ? <UserAvatar userId={o.id} size={20} showStatus={false} /> : <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: roles[o.id]?.color ? `#${roles[o.id].color.toString(16).padStart(6, "0")}` : "rgb(var(--fg-3))" }} />}
            <span className="truncate">{label(o)}</span>
          </button>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="scroll-thin flex-1 overflow-y-auto p-5">
          <h3 className="mb-4 font-display text-[17px] font-semibold">{current ? label(current) : ""}</h3>
          {groups.map((g) => (
            <section key={g.key} className="mb-5">
              <h4 className="mb-1 text-[12.5px] font-semibold text-fg-3">{t(`perm.groups.${g.key}`)}</h4>
              {g.perms.map((p) => (
                <div key={p} className="flex items-center justify-between gap-4 border-b border-line/8 py-2.5">
                  <PermLabel name={p} />
                  <TriState value={stateOf(current, p)} onChange={(v) => setBit(p, v)} />
                </div>
              ))}
            </section>
          ))}
        </div>
        <div className="flex justify-end gap-2 border-t border-line/10 p-3">
          {sel !== c.guildId && (
            <Button
              variant="ghost"
              onClick={() => {
                setList(list.filter((o) => o.id !== sel));
                setSel(c.guildId!);
              }}
            >
              {t("common.remove")}
            </Button>
          )}
          <Button variant="success" loading={busy} onClick={() => void save()}>
            {t("common.save")}
          </Button>
        </div>
      </div>
      <Popover anchor={add.anchor} onClose={add.close}>
        <MenuList
          className="max-h-80 overflow-y-auto"
          onClose={add.close}
          items={[
            ...Object.values(roles)
              .filter((r) => r.id !== c.guildId && !list.some((o) => o.id === r.id))
              .sort((a, b) => b.position - a.position)
              .map((r) => ({ label: r.name, onSelect: () => (setList([...list, { id: r.id, type: "role" as const, allow: "0", deny: "0" }]), setSel(r.id)) })),
            { separator: true },
            ...Object.keys(members)
              .filter((u) => !list.some((o) => o.id === u))
              .slice(0, 50)
              .map((u) => ({ label: displayName(s, u, c.guildId), onSelect: () => (setList([...list, { id: u, type: "member" as const, allow: "0", deny: "0" }]), setSel(u)) })),
          ]}
        />
      </Popover>
    </div>
  );
}
