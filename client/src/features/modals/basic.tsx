import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import clsx from "clsx";
import { Hash, Volume2, Folder, Lock, Plus, Trash2, Copy, Check, Upload, Search, Link2, Gamepad2, Users, BookOpen, Sparkles, Home } from "lucide-react";
import { Permission, type ChannelDTO, type GuildCreatePayload, type InviteDTO } from "@nova/shared";
import { api, uploadImage } from "../../lib/api";
import { errorText, t } from "../../lib/i18n";
import { toast } from "../../lib/bus";
import { mediaUrl, webLink } from "../../lib/server";
import { getLocale } from "../../lib/i18n";
import { RelationshipType } from "@nova/shared";
import { displayName, useData } from "../../store/data";
import { navigate, useUI, type Modal as ModalState } from "../../store/ui";
import { Modal, ModalFooter, ModalHeader } from "../../components/ui/overlay";
import { Button, Input, Switch, Segmented, useCopy, Field } from "../../components/ui/primitives";
import { GuildIcon, UserAvatar } from "../../components/ui/avatar";
import { EmojiPicker } from "../chat/EmojiPicker";
import { Popover, usePopover } from "../../components/ui/overlay";

// ── confirm ──────────────────────────────────────────────────────────────────
export function ConfirmModal({ title, body, danger, confirmLabel, onConfirm, typeToConfirm, onClose }: Extract<ModalState, { kind: "confirm" }> & { onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState("");
  const ok = !typeToConfirm || typed.trim() === typeToConfirm;
  return (
    <Modal open onClose={onClose} width={440}>
      <ModalHeader title={title} subtitle={body} />
      {typeToConfirm && (
        <div className="px-6 pb-4">
          <Input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={typeToConfirm} />
        </div>
      )}
      <ModalFooter>
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          variant={danger ? "danger" : "primary"}
          loading={busy}
          disabled={!ok}
          autoFocus={!typeToConfirm}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
              onClose();
            } catch (e) {
              toast(errorText(e), "error");
              setBusy(false);
            }
          }}
        >
          {confirmLabel ?? t("common.confirm")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

// ── create / join guild ──────────────────────────────────────────────────────
const TEMPLATES = [
  { id: "default", icon: Home },
  { id: "gaming", icon: Gamepad2 },
  { id: "friends", icon: Users },
  { id: "study", icon: BookOpen },
  { id: "empty", icon: Sparkles },
] as const;

export function CreateGuildModal({ onClose }: { onClose: () => void }) {
  const me = useData((s) => s.me);
  const [step, setStep] = useState<"pick" | "name" | "join">("pick");
  const [template, setTemplate] = useState<(typeof TEMPLATES)[number]["id"]>("default");
  const [name, setName] = useState(t("guild.defaultName", { name: me?.displayName || me?.username || "" }));
  const [icon, setIcon] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState("");

  const create = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    try {
      const g = await api<GuildCreatePayload>("/api/guilds", { method: "POST", body: { name: name.trim(), icon, template, locale: getLocale() } });
      onClose();
      const first = g.channels.find((c) => c.type === "text");
      navigate(g.id, first?.id ?? null);
    } catch (err) {
      toast(errorText(err), "error");
      setBusy(false);
    }
  };
  const pickIcon = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        setIcon((await uploadImage(f, "icon")).url);
      } catch (err) {
        toast(errorText(err), "error");
      }
    };
    input.click();
  };

  return (
    <Modal open onClose={onClose} width={460}>
      {step === "pick" && (
        <>
          <ModalHeader title={t("guild.createTitle")} subtitle={t("guild.createSubtitle")} className="text-center" />
          <div className="flex flex-col gap-2 px-5 pb-4 pt-3">
            {TEMPLATES.map(({ id, icon: Icon }) => (
              <button
                key={id}
                onClick={() => {
                  setTemplate(id);
                  setStep("name");
                }}
                className="flex items-center gap-3 rounded-xl bg-raised/60 px-4 py-3 text-left font-semibold ring-1 ring-line/10 transition-colors hover:bg-raised hover:ring-star/40"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-star/15 text-star">
                  <Icon size={20} />
                </span>
                {t(`guild.templates.${id}`)}
              </button>
            ))}
          </div>
          <ModalFooter className="flex-col !items-stretch gap-2">
            <div className="text-center text-[14px] font-semibold">{t("guild.orJoin")}</div>
            <Button variant="secondary" onClick={() => setStep("join")}>
              {t("guild.joinTitle")}
            </Button>
          </ModalFooter>
        </>
      )}
      {step === "name" && (
        <form onSubmit={create}>
          <ModalHeader title={t("guild.createTitle")} className="text-center" />
          <div className="flex flex-col items-center gap-5 px-6 pb-6 pt-2">
            <button type="button" onClick={pickIcon} className="group relative flex h-24 w-24 items-center justify-center rounded-full border-2 border-dashed border-fg-3/60 text-fg-3 transition-colors hover:border-star hover:text-star">
              {icon ? <img src={mediaUrl(icon, 96)} alt="" className="h-full w-full rounded-full object-cover" /> : <Upload size={26} />}
              <span className="absolute -right-1 -top-1 flex h-7 w-7 items-center justify-center rounded-full bg-star text-on-star">
                <Plus size={16} />
              </span>
            </button>
            <Input label={t("guild.name")} value={name} autoFocus onChange={(e) => setName(e.target.value)} maxLength={100} className="w-full" />
          </div>
          <ModalFooter className="justify-between">
            <Button variant="ghost" type="button" onClick={() => setStep("pick")}>
              {t("common.back")}
            </Button>
            <Button type="submit" loading={busy} disabled={name.trim().length < 2}>
              {t("common.create")}
            </Button>
          </ModalFooter>
        </form>
      )}
      {step === "join" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const code = invite.trim().replace(/^.*\/invite\//, "").replace(/[^\w-]/g, "");
            if (code) useUI.getState().setModal({ kind: "acceptInvite", code });
          }}
        >
          <ModalHeader title={t("guild.joinTitle")} subtitle={t("guild.joinSubtitle")} className="text-center" />
          <div className="px-6 pb-6 pt-2">
            <Input autoFocus value={invite} onChange={(e) => setInvite(e.target.value)} placeholder={t("guild.joinPlaceholder")} right={<Link2 size={16} className="text-fg-3" />} />
          </div>
          <ModalFooter className="justify-between">
            <Button variant="ghost" type="button" onClick={() => setStep("pick")}>
              {t("common.back")}
            </Button>
            <Button type="submit" disabled={!invite.trim()}>
              {t("common.join")}
            </Button>
          </ModalFooter>
        </form>
      )}
    </Modal>
  );
}

export function AcceptInviteModal({ code, onClose }: { code: string; onClose: () => void }) {
  const [invite, setInvite] = useState<InviteDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const member = useData((s) => (invite ? !!s.guilds[invite.guild.id] : false));
  useEffect(() => {
    api<InviteDTO>(`/api/invites/${code}`, { auth: false })
      .then(setInvite)
      .catch((e) => setError(errorText(e)));
  }, [code]);
  const accept = async () => {
    if (!invite) return;
    if (member) {
      onClose();
      return navigate(invite.guild.id, invite.channel?.id ?? null);
    }
    setBusy(true);
    try {
      const r = await api<{ guildId: string; channelId: string | null }>(`/api/invites/${code}`, { method: "POST" });
      onClose();
      // GUILD_CREATE arrives over the gateway; navigate once it's there.
      const go = () => navigate(r.guildId, r.channelId);
      if (useData.getState().guilds[r.guildId]) go();
      else {
        const off = useData.subscribe((s) => {
          if (s.guilds[r.guildId]) {
            off();
            go();
          }
        });
        setTimeout(off, 10_000);
      }
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} width={420}>
      <div className="flex flex-col items-center px-6 pb-2 pt-8 text-center">
        {invite ? (
          <>
            <GuildIcon guildId={invite.guild.id} name={invite.guild.name} icon={invite.guild.icon} size={80} active />
            <div className="mt-4 text-[14px] text-fg-2">{t("guild.youWereInvited")}</div>
            <div className="mt-1 font-display text-[22px] font-semibold tracking-[-0.01em]">{invite.guild.name}</div>
            {invite.guild.description && <p className="mt-2 text-[14px] text-fg-2">{invite.guild.description}</p>}
            <div className="mt-3 flex items-center gap-4 text-[13px] text-fg-3">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-ok" /> {t("guild.onlineCount", { n: invite.guild.onlineCount })}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-fg-3" /> {t("guild.memberCount", { n: invite.guild.memberCount })}
              </span>
            </div>
          </>
        ) : error ? (
          <div className="py-8 text-bad">{error}</div>
        ) : (
          <div className="skeleton h-20 w-20 rounded-full" />
        )}
      </div>
      <div className="p-6">
        <Button block size="lg" loading={busy} disabled={!invite} onClick={() => void accept()}>
          {member ? t("guild.alreadyMember") : t("guild.accept")}
        </Button>
      </div>
    </Modal>
  );
}

// ── invite ───────────────────────────────────────────────────────────────────
const AGES = [1800, 3600, 21600, 43200, 86400, 604800, 0];
const ageLabel = (v: number) =>
  v === 0 ? t("invite.noExpiry") : v < 3600 ? t("time.minutesLong", { n: v / 60 }) : v < 86400 ? t("poll.hours", { n: v / 3600 }) : t("poll.days", { n: v / 86400 });

export const inviteLink = (code: string) => webLink(`/invite/${code}`);

export function InviteModal({ guildId, channelId, onClose }: { guildId: string; channelId?: string; onClose: () => void }) {
  const guild = useData((s) => s.guilds[guildId]);
  const [maxAge, setMaxAge] = useState(604800);
  const [maxUses, setMaxUses] = useState(0);
  const [invite, setInvite] = useState<InviteDTO | null>(null);
  const [edit, setEdit] = useState(false);
  const [copied, copy] = useCopy();
  const friends = useData(useShallow((s) => Object.values(s.relationships).filter((r) => r.type === RelationshipType.FRIEND)));
  const [sent, setSent] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState("");

  const generate = async () => {
    try {
      const path = channelId ? `/api/channels/${channelId}/invites` : `/api/guilds/${guildId}/invites`;
      setInvite(await api<InviteDTO>(path, { method: "POST", body: { maxAge, maxUses } }));
    } catch (e) {
      toast(errorText(e), "error");
    }
  };
  useEffect(() => {
    void generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const link = invite ? inviteLink(invite.code) : "";
  const sendTo = async (userId: string) => {
    try {
      const dm = await api<ChannelDTO>("/api/users/@me/channels", { method: "POST", body: { recipientId: userId } });
      await api(`/api/channels/${dm.id}/messages`, { method: "POST", body: { content: link } });
      setSent((s) => ({ ...s, [userId]: true }));
    } catch (e) {
      toast(errorText(e), "error");
    }
  };
  const s = useData.getState();
  const filtered = friends.filter((f) => !q || displayName(s, f.userId).toLowerCase().includes(q.toLowerCase())).slice(0, 30);

  return (
    <Modal open onClose={onClose} width={460}>
      <ModalHeader title={t("invite.title", { name: guild?.name ?? "" })} subtitle={t("invite.subtitle")} />
      {friends.length > 0 && (
        <div className="px-6">
          <div className="relative mb-2">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-3" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("invite.friends")} className="h-9 w-full rounded-lg bg-canvas/70 pl-9 pr-3 text-[14px] outline-none ring-1 ring-line/10 focus:ring-star/60" />
          </div>
          <div className="scroll-thin max-h-48 overflow-y-auto">
            {filtered.map((f) => (
              <div key={f.userId} className="flex items-center gap-3 rounded-lg px-1 py-1.5 hover:bg-raised/50">
                <UserAvatar userId={f.userId} size={32} statusRing="ring-surface" />
                <span className="min-w-0 flex-1 truncate font-medium">{displayName(s, f.userId)}</span>
                <Button size="sm" variant={sent[f.userId] ? "ghost" : "success"} disabled={sent[f.userId] || !invite} onClick={() => void sendTo(f.userId)}>
                  {sent[f.userId] ? t("invite.sent") : t("invite.sendTo")}
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="px-6 pb-6 pt-4">
        <div className="flex items-center gap-2 rounded-xl bg-canvas/70 p-1.5 pl-3 ring-1 ring-line/10">
          <span className="min-w-0 flex-1 truncate font-mono text-[13.5px] text-fg-2">{link || "…"}</span>
          <Button size="sm" variant={copied ? "success" : "primary"} onClick={() => copy(link)} icon={copied ? <Check size={14} /> : <Copy size={14} />}>
            {copied ? t("common.copied") : t("common.copy")}
          </Button>
        </div>
        <div className="mt-2 flex items-center justify-between text-[12.5px] text-fg-3">
          <span>{t("invite.expiresIn", { t: ageLabel(maxAge).toLowerCase() })}</span>
          <button onClick={() => setEdit(!edit)} className="font-semibold text-sky hover:underline">
            {t("invite.edit")}
          </button>
        </div>
        {edit && (
          <div className="mt-4 flex flex-col gap-3 rounded-xl bg-raised/50 p-4">
            <Field label={t("invite.maxAge")}>
              <select value={maxAge} onChange={(e) => setMaxAge(Number(e.target.value))} className="h-10 rounded-lg bg-canvas px-3 outline-none ring-1 ring-line/10">
                {AGES.map((v) => (
                  <option key={v} value={v}>
                    {ageLabel(v)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("invite.maxUses")}>
              <select value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))} className="h-10 rounded-lg bg-canvas px-3 outline-none ring-1 ring-line/10">
                {[0, 1, 5, 10, 25, 50, 100].map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? t("invite.unlimited") : n}
                  </option>
                ))}
              </select>
            </Field>
            <Button
              onClick={() => {
                void generate();
                setEdit(false);
              }}
            >
              {t("invite.generate")}
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ── create channel ──────────────────────────────────────────────────────────
export function CreateChannelModal({ guildId, parentId, type: initialType, onClose }: { guildId: string; parentId?: string | null; type?: "text" | "voice" | "category"; onClose: () => void }) {
  const [type, setType] = useState<"text" | "voice" | "category">(initialType ?? "text");
  const [name, setName] = useState("");
  const [priv, setPriv] = useState(false);
  const [allowRoles, setAllowRoles] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const roles = useData(useShallow((s) => Object.values(s.roles[guildId] ?? {}).filter((r) => r.id !== guildId).sort((a, b) => b.position - a.position)));
  const parentName = useData((s) => (parentId ? s.channels[parentId]?.name : null));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const view = Permission.VIEW_CHANNEL.toString();
    const overwrites = priv ? [{ id: guildId, type: "role", allow: "0", deny: view }, ...allowRoles.map((id) => ({ id, type: "role", allow: view, deny: "0" }))] : undefined;
    try {
      const c = await api<ChannelDTO>(`/api/guilds/${guildId}/channels`, { method: "POST", body: { name: name.trim(), type, parentId: type === "category" ? null : parentId ?? null, overwrites } });
      onClose();
      if (c.type === "text") navigate(guildId, c.id);
    } catch (err) {
      toast(errorText(err), "error");
      setBusy(false);
    }
  };
  const options = [
    { v: "text" as const, icon: <Hash size={22} />, label: t("channel.text"), hint: t("channel.textHint") },
    { v: "voice" as const, icon: <Volume2 size={22} />, label: t("channel.voice"), hint: t("channel.voiceHint") },
    { v: "category" as const, icon: <Folder size={22} />, label: t("channel.category"), hint: t("channel.categoryHint") },
  ];
  return (
    <Modal open onClose={onClose} width={460}>
      <form onSubmit={submit}>
        <ModalHeader title={t("channel.createTitle")} subtitle={parentName ? t("channel.inCategory", { name: parentName }) : undefined} />
        <div className="flex flex-col gap-4 px-6 pb-5 pt-2">
          {!initialType || initialType !== "category" ? (
            <div className="flex flex-col gap-2">
              {options.map((o) => (
                <button
                  type="button"
                  key={o.v}
                  onClick={() => setType(o.v)}
                  className={clsx("flex items-center gap-3 rounded-xl px-3.5 py-3 text-left ring-1 transition-colors", type === o.v ? "bg-raised ring-star/60" : "bg-raised/40 ring-line/10 hover:bg-raised/70")}
                >
                  <span className="text-fg-2">{o.icon}</span>
                  <span className="flex-1">
                    <span className="block font-semibold">{o.label}</span>
                    <span className="block text-[12.5px] text-fg-3">{o.hint}</span>
                  </span>
                  <span className={clsx("h-4 w-4 rounded-full border-2", type === o.v ? "border-star bg-star" : "border-fg-3")} />
                </button>
              ))}
            </div>
          ) : null}
          <Input
            label={t("channel.name")}
            autoFocus
            value={name}
            onChange={(e) => setName(type === "text" ? e.target.value.toLowerCase().replace(/\s+/g, "-") : e.target.value)}
            placeholder={type === "text" ? t("channel.namePlaceholder") : ""}
            maxLength={100}
          />
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-1.5 font-semibold">
                <Lock size={15} /> {t("channel.private")}
              </div>
              <div className="text-[12.5px] text-fg-3">{t("channel.privateHint")}</div>
            </div>
            <Switch checked={priv} onChange={setPriv} />
          </div>
          {priv && roles.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {roles.map((r) => (
                <button
                  type="button"
                  key={r.id}
                  onClick={() => setAllowRoles((a) => (a.includes(r.id) ? a.filter((x) => x !== r.id) : [...a, r.id]))}
                  className={clsx("flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[13px] font-medium ring-1", allowRoles.includes(r.id) ? "bg-star/15 ring-star/50" : "ring-line/15")}
                >
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: r.color ? `#${r.color.toString(16).padStart(6, "0")}` : "rgb(var(--fg-3))" }} />
                  {r.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <ModalFooter>
          <Button variant="ghost" type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={busy} disabled={!name.trim()}>
            {t("common.create")}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

// ── poll ─────────────────────────────────────────────────────────────────────
export function PollModal({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const [question, setQuestion] = useState("");
  const [answers, setAnswers] = useState(["", ""]);
  const [multi, setMulti] = useState(false);
  const [hours, setHours] = useState(24);
  const [busy, setBusy] = useState(false);
  const valid = question.trim() && answers.filter((a) => a.trim()).length >= 2;
  const submit = async () => {
    setBusy(true);
    try {
      await api(`/api/channels/${channelId}/messages`, {
        method: "POST",
        body: { content: "", poll: { question: question.trim(), answers: answers.filter((a) => a.trim()).map((text) => ({ text: text.trim() })), allowMultiselect: multi, durationHours: hours } },
      });
      onClose();
    } catch (e) {
      toast(errorText(e), "error");
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} width={480}>
      <ModalHeader title={t("poll.create")} />
      <div className="flex flex-col gap-4 px-6 pb-5 pt-2">
        <Input label={t("poll.question")} placeholder={t("poll.questionPlaceholder")} value={question} autoFocus maxLength={300} onChange={(e) => setQuestion(e.target.value)} />
        <div className="flex flex-col gap-2">
          {answers.map((a, i) => (
            <div key={i} className="flex gap-2">
              <Input value={a} placeholder={t("poll.answer", { n: i + 1 })} maxLength={100} onChange={(e) => setAnswers(answers.map((x, j) => (j === i ? e.target.value : x)))} />
              {answers.length > 2 && (
                <button onClick={() => setAnswers(answers.filter((_, j) => j !== i))} className="rounded-lg px-2 text-fg-3 hover:text-bad" aria-label={t("common.remove")}>
                  <Trash2 size={16} />
                </button>
              )}
            </div>
          ))}
          {answers.length < 10 && (
            <button onClick={() => setAnswers([...answers, ""])} className="flex items-center gap-1.5 self-start text-[14px] font-semibold text-sky hover:underline">
              <Plus size={15} /> {t("poll.addAnswer")}
            </button>
          )}
        </div>
        <div className="flex items-center justify-between">
          <span className="font-medium">{t("poll.multi")}</span>
          <Switch checked={multi} onChange={setMulti} />
        </div>
        <Field label={t("poll.duration")}>
          <Segmented
            value={String(hours)}
            onChange={(v) => setHours(Number(v))}
            options={[
              { value: "1", label: t("poll.hours", { n: 1 }) },
              { value: "24", label: t("poll.days", { n: 1 }) },
              { value: "72", label: t("poll.days", { n: 3 }) },
              { value: "168", label: t("poll.days", { n: 7 }) },
              { value: "0", label: t("poll.noLimit") },
            ]}
          />
        </Field>
      </div>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button disabled={!valid} loading={busy} onClick={() => void submit()}>
          {t("common.create")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

// ── schedule ─────────────────────────────────────────────────────────────────
export function ScheduleModal({ channelId, content, onClose }: { channelId: string; content: string; onClose: () => void }) {
  const [text, setText] = useState(content);
  const initial = useMemo(() => {
    const d = new Date(Date.now() + 60 * 60_000);
    d.setSeconds(0, 0);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  }, []);
  const [when, setWhen] = useState(initial);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api(`/api/channels/${channelId}/scheduled`, { method: "POST", body: { content: text, sendAt: new Date(when).toISOString() } });
      toast(t("chat.scheduled", { time: new Date(when).toLocaleString() }), "success");
      onClose();
    } catch (e) {
      toast(errorText(e), "error");
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} width={440}>
      <ModalHeader title={t("chat.scheduleTitle")} />
      <div className="flex flex-col gap-4 px-6 pb-5 pt-2">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} className="w-full resize-none rounded-xl bg-canvas/70 p-3 outline-none ring-1 ring-line/10 focus:ring-star/60" />
        <Input label={t("chat.scheduleAt")} type="datetime-local" value={when} min={initial.slice(0, 16)} onChange={(e) => setWhen(e.target.value)} />
      </div>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button disabled={!text.trim()} loading={busy} onClick={() => void submit()}>
          {t("chat.schedule")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

// ── new DM / group ──────────────────────────────────────────────────────────
export function NewDmModal({ onClose }: { onClose: () => void }) {
  const friends = useData(useShallow((s) => Object.values(s.relationships).filter((r) => r.type === RelationshipType.FRIEND)));
  const [picked, setPicked] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const s = useData.getState();
  const list = friends.filter((f) => !q || displayName(s, f.userId).toLowerCase().includes(q.toLowerCase()) || s.users[f.userId]?.username.includes(q.toLowerCase()));
  const submit = async () => {
    setBusy(true);
    try {
      const c = await api<ChannelDTO>("/api/users/@me/channels", { method: "POST", body: picked.length === 1 ? { recipientId: picked[0] } : { recipients: picked } });
      onClose();
      navigate("@me", c.id);
    } catch (e) {
      toast(errorText(e), "error");
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} width={440}>
      <ModalHeader title={t("nav.newDm")} subtitle={`${picked.length}/9`} />
      <div className="px-6">
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("common.search")} />
      </div>
      <div className="scroll-thin max-h-72 overflow-y-auto px-4 py-3">
        {list.map((f) => {
          const on = picked.includes(f.userId);
          return (
            <button
              key={f.userId}
              onClick={() => setPicked(on ? picked.filter((x) => x !== f.userId) : picked.length < 9 ? [...picked, f.userId] : picked)}
              className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-raised/60"
            >
              <UserAvatar userId={f.userId} size={32} statusRing="ring-surface" />
              <span className="min-w-0 flex-1 truncate font-medium">{displayName(s, f.userId)}</span>
              <span className={clsx("flex h-5 w-5 items-center justify-center rounded-md border-2", on ? "border-star bg-star text-on-star" : "border-fg-3")}>{on && <Check size={13} />}</span>
            </button>
          );
        })}
        {!list.length && <div className="py-6 text-center text-[14px] text-fg-3">{t("friends.emptyAll")}</div>}
      </div>
      <ModalFooter>
        <Button disabled={!picked.length} loading={busy} onClick={() => void submit()} block>
          {picked.length > 1 ? t("friends.createGroup") : t("friends.message")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

// ── custom status ────────────────────────────────────────────────────────────
export function CustomStatusModal({ onClose }: { onClose: () => void }) {
  const me = useData((s) => s.me);
  const [text, setText] = useState(me?.customStatus?.text ?? "");
  const [emoji, setEmoji] = useState<string | null>(me?.customStatus?.emoji ?? null);
  const [ttl, setTtl] = useState<number>(0);
  const pop = usePopover();
  const save = async () => {
    await api("/api/users/@me/status", { method: "PATCH", body: { customStatus: text || emoji ? { text: text || null, emoji, expiresAt: ttl ? Date.now() + ttl : null } : null } }).catch((e) => toast(errorText(e), "error"));
    onClose();
  };
  const endOfDay = () => {
    const d = new Date();
    d.setHours(23, 59, 59, 0);
    return d.getTime() - Date.now();
  };
  return (
    <Modal open onClose={onClose} width={420}>
      <ModalHeader title={t("status.custom")} />
      <div className="flex flex-col gap-4 px-6 pb-5 pt-2">
        <div className="flex items-center gap-2 rounded-xl bg-canvas/70 p-1.5 ring-1 ring-line/10 focus-within:ring-star/60">
          <button onClick={pop.toggle} className="flex h-9 w-9 items-center justify-center rounded-lg text-[20px] hover:bg-raised" aria-label={t("chat.emoji")}>
            {emoji ?? "🙂"}
          </button>
          <input autoFocus value={text} maxLength={128} onChange={(e) => setText(e.target.value)} placeholder={t("status.customPlaceholder")} className="h-9 flex-1 bg-transparent outline-none" />
          {(text || emoji) && (
            <button
              onClick={() => {
                setText("");
                setEmoji(null);
              }}
              className="px-2 text-fg-3 hover:text-fg"
            >
              ✕
            </button>
          )}
        </div>
        <Field label={t("status.clearAfter")}>
          <select value={ttl} onChange={(e) => setTtl(Number(e.target.value))} className="h-10 rounded-lg bg-canvas px-3 outline-none ring-1 ring-line/10">
            <option value={0}>{t("status.never")}</option>
            <option value={30 * 60_000}>{t("status.min30")}</option>
            <option value={3_600_000}>{t("status.hour1")}</option>
            <option value={4 * 3_600_000}>{t("status.hour4")}</option>
            <option value={endOfDay()}>{t("status.today")}</option>
          </select>
        </Field>
      </div>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button onClick={() => void save()}>{t("common.save")}</Button>
      </ModalFooter>
      <Popover anchor={pop.anchor} onClose={pop.close}>
        <EmojiPicker onClose={pop.close} onPick={(e) => !e.custom && setEmoji(e.text)} />
      </Popover>
    </Modal>
  );
}

// ── moderation ───────────────────────────────────────────────────────────────
export function BanModal({ guildId, userId, onClose }: { guildId: string; userId: string; onClose: () => void }) {
  const name = useData((s) => displayName(s, userId, guildId));
  const [reason, setReason] = useState("");
  const [del, setDel] = useState(0);
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onClose={onClose} width={440}>
      <ModalHeader title={t("profile.banTitle", { name })} />
      <div className="flex flex-col gap-4 px-6 pb-5 pt-2">
        <Field label={t("profile.banDelete")}>
          <select value={del} onChange={(e) => setDel(Number(e.target.value))} className="h-10 rounded-lg bg-canvas px-3 outline-none ring-1 ring-line/10">
            <option value={0}>{t("profile.banNone")}</option>
            <option value={3600}>{t("profile.ban1h")}</option>
            <option value={86400}>{t("profile.ban1d")}</option>
            <option value={604800}>{t("profile.ban7d")}</option>
          </select>
        </Field>
        <Input label={t("profile.banReason")} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={512} />
      </div>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="danger"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api(`/api/guilds/${guildId}/bans/${userId}`, { method: "PUT", body: { reason: reason || undefined, deleteMessageSeconds: del } });
              onClose();
            } catch (e) {
              toast(errorText(e), "error");
              setBusy(false);
            }
          }}
        >
          {t("profile.ban")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

export function TimeoutModal({ guildId, userId, onClose }: { guildId: string; userId: string; onClose: () => void }) {
  const name = useData((s) => displayName(s, userId, guildId));
  const [ms, setMs] = useState(600_000);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const opts: [number, string][] = [
    [60_000, t("profile.t60")],
    [300_000, t("profile.t5m")],
    [600_000, t("profile.t10m")],
    [3_600_000, t("profile.t1h")],
    [86_400_000, t("profile.t1d")],
    [604_800_000, t("profile.t1w")],
  ];
  return (
    <Modal open onClose={onClose} width={440}>
      <ModalHeader title={t("profile.timeoutTitle", { name })} subtitle={t("profile.timeoutHint")} />
      <div className="flex flex-col gap-4 px-6 pb-5 pt-2">
        <div className="grid grid-cols-3 gap-2">
          {opts.map(([v, l]) => (
            <button key={v} onClick={() => setMs(v)} className={clsx("rounded-xl px-2 py-2 text-[13.5px] font-semibold ring-1", ms === v ? "bg-star/15 text-star ring-star/50" : "ring-line/15 hover:bg-raised")}>
              {l}
            </button>
          ))}
        </div>
        <Input label={t("profile.banReason")} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={512} />
      </div>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="danger"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api(`/api/guilds/${guildId}/members/${userId}`, { method: "PATCH", body: { timeoutUntil: new Date(Date.now() + ms).toISOString(), reason: reason || undefined } });
              onClose();
            } catch (e) {
              toast(errorText(e), "error");
              setBusy(false);
            }
          }}
        >
          {t("profile.timeout")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
