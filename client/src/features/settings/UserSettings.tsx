import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Monitor, Smartphone, Globe, Upload, Trash2, Mic, Check } from "lucide-react";
import { hexToColor, colorToHex, type SessionDTO } from "@nova/shared";
import { api, uploadImage } from "../../lib/api";
import { errorText, t, useLocale, type Locale } from "../../lib/i18n";
import { toast } from "../../lib/bus";
import { fmtRelative } from "../../lib/time";
import { isDesktop } from "../../lib/platform";
import { mediaUrl } from "../../lib/server";
import { ensureNotificationPermission } from "../../lib/notifications";
import { applySink, playSound } from "../../lib/sound";
import { useData } from "../../store/data";
import { logout } from "../../store/session";
import { confirmDialog } from "../../store/ui";
import { settings, useSettings, type Theme, type Effects } from "../../store/settings";
import { Button, Input, Textarea, Switch, SettingRow, Slider, Segmented, Field, Kbd } from "../../components/ui/primitives";
import { UserAvatar } from "../../components/ui/avatar";
import { Markdown } from "../chat/markdown";
import { startMicTest } from "../voice/processor";
import { SettingsLayout, SectionTitle, Group } from "./SettingsLayout";

type Tab = "account" | "profile" | "appearance" | "voice" | "notifications" | "keybinds" | "sessions" | "language" | "advanced" | "desktop" | "about";

export default function UserSettings({ tab: initial, onClose }: { tab?: string; onClose: () => void }) {
  const [tab, setTab] = useState<Tab | null>((initial as Tab) ?? (window.innerWidth < 768 ? null : "account"));
  useLocale();
  const sections = [
    {
      title: t("settings.userSection"),
      items: [
        { id: "account", label: t("settings.account") },
        { id: "profile", label: t("settings.profile") },
        { id: "sessions", label: t("settings.sessions") },
      ],
    },
    {
      title: t("settings.appSection"),
      items: [
        { id: "appearance", label: t("settings.appearance") },
        { id: "voice", label: t("settings.voice") },
        { id: "notifications", label: t("settings.notifications") },
        { id: "keybinds", label: t("settings.keybinds") },
        { id: "language", label: t("settings.language") },
        { id: "advanced", label: t("settings.advanced") },
        ...(isDesktop ? [{ id: "desktop", label: t("settings.desktop") }] : []),
        { id: "about", label: t("settings.about") },
      ],
    },
    {
      items: [
        {
          id: "logout",
          label: t("settings.logout"),
          danger: true,
          onClick: () => confirmDialog({ title: t("settings.logout"), body: t("settings.logoutConfirm"), danger: true, confirmLabel: t("settings.logout"), onConfirm: () => logout() }),
        },
      ],
    },
  ];
  return (
    <SettingsLayout sections={sections} active={tab} onSelect={(id) => setTab(id as Tab | null)} onClose={onClose}>
      {tab === "account" && <Account />}
      {tab === "profile" && <Profile />}
      {tab === "appearance" && <Appearance />}
      {tab === "voice" && <Voice />}
      {tab === "notifications" && <Notifications />}
      {tab === "keybinds" && <Keybinds />}
      {tab === "sessions" && <Sessions />}
      {tab === "language" && <Language />}
      {tab === "advanced" && <Advanced />}
      {tab === "desktop" && <Desktop />}
      {tab === "about" && <About />}
    </SettingsLayout>
  );
}

// ── account ──────────────────────────────────────────────────────────────────
function Account() {
  const me = useData((s) => s.me)!;
  const [mode, setMode] = useState<null | "username" | "email" | "password">(null);
  const [value, setValue] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const body: Record<string, string> = { password };
      if (mode === "username") body.username = value;
      if (mode === "email") body.email = value;
      if (mode === "password") body.newPassword = value;
      await api("/api/users/@me/account", { method: "PATCH", body });
      toast(mode === "password" ? t("settings.passwordChanged") : t("common.saved"), "success");
      setMode(null);
      setValue("");
      setPassword("");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const rows: { key: "username" | "email"; label: string; value: string }[] = [
    { key: "username", label: t("auth.username"), value: "@" + me.username },
    { key: "email", label: t("auth.email"), value: me.email.replace(/(^.).*(@.*$)/, "$1•••$2") },
  ];
  return (
    <>
      <SectionTitle>{t("settings.account")}</SectionTitle>
      <div className="mb-8 overflow-hidden rounded-2xl bg-panel hairline">
        <div className="h-20" style={{ background: me.accentColor ? colorToHex(me.accentColor)! : "linear-gradient(120deg, rgb(var(--star)/.5), rgb(var(--sky-glow)/.7))" }} />
        <div className="flex items-end gap-4 px-5 pb-5">
          <div className="-mt-10 rounded-full bg-panel p-1.5">
            <UserAvatar userId={me.id} size={80} statusRing="ring-panel" />
          </div>
          <div className="pb-1">
            <div className="text-[18px] font-semibold">{me.displayName || me.username}</div>
            <div className="text-[13.5px] text-fg-3">@{me.username}</div>
          </div>
        </div>
        <div className="mx-4 mb-4 divide-y divide-line/8 rounded-xl bg-canvas/50 px-4">
          {rows.map((r) => (
            <div key={r.key} className="flex items-center justify-between py-3">
              <div>
                <div className="text-[12.5px] font-semibold text-fg-3">{r.label}</div>
                <div>{r.value}</div>
              </div>
              <Button size="sm" variant="secondary" onClick={() => setMode(r.key)}>
                {t("common.edit")}
              </Button>
            </div>
          ))}
        </div>
      </div>
      <Group title={t("settings.changePassword")}>
        <div className="py-3">
          <Button variant="secondary" onClick={() => setMode("password")}>
            {t("settings.changePassword")}
          </Button>
        </div>
      </Group>
      {mode && (
        <div className="rounded-2xl bg-panel p-5 hairline anim-pop">
          <h3 className="mb-4 font-semibold">{mode === "username" ? t("settings.changeUsername") : mode === "email" ? t("settings.changeEmail") : t("settings.changePassword")}</h3>
          <div className="flex flex-col gap-3">
            <Input label={mode === "password" ? t("settings.newPassword") : mode === "email" ? t("auth.email") : t("auth.username")} type={mode === "password" ? "password" : "text"} value={value} onChange={(e) => setValue(mode === "username" ? e.target.value.toLowerCase() : e.target.value)} autoFocus />
            <Input label={t("settings.currentPassword")} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setMode(null)}>
                {t("common.cancel")}
              </Button>
              <Button loading={busy} disabled={!value || !password} onClick={() => void submit()}>
                {t("common.save")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── profile ──────────────────────────────────────────────────────────────────
function Profile() {
  const me = useData((s) => s.me)!;
  const [form, setForm] = useState({ displayName: me.displayName ?? "", pronouns: me.pronouns ?? "", bio: me.bio ?? "", accentColor: me.accentColor, avatar: me.avatar, banner: me.banner });
  const [busy, setBusy] = useState(false);
  const dirty = form.displayName !== (me.displayName ?? "") || form.pronouns !== (me.pronouns ?? "") || form.bio !== (me.bio ?? "") || form.accentColor !== me.accentColor || form.avatar !== me.avatar || form.banner !== me.banner;
  const pick = (kind: "avatar" | "banner") => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        const r = await uploadImage(f, kind);
        setForm((x) => ({ ...x, [kind]: r.url }));
      } catch (e) {
        toast(errorText(e), "error");
      }
    };
    input.click();
  };
  const save = async () => {
    setBusy(true);
    try {
      await api("/api/users/@me", { method: "PATCH", body: { displayName: form.displayName || null, pronouns: form.pronouns || null, bio: form.bio || null, accentColor: form.accentColor, avatar: form.avatar, banner: form.banner } });
      toast(t("common.saved"), "success");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const accentHex = colorToHex(form.accentColor) ?? "#ffc35c";
  return (
    <>
      <SectionTitle>{t("settings.profile")}</SectionTitle>
      <div className="grid gap-8 lg:grid-cols-[1fr_300px]">
        <div className="flex flex-col gap-5">
          <Input label={t("auth.displayName")} value={form.displayName} maxLength={32} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          <Input label={t("settings.pronouns")} value={form.pronouns} maxLength={40} onChange={(e) => setForm({ ...form, pronouns: e.target.value })} />
          <Field label={t("settings.avatar")}>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" icon={<Upload size={14} />} onClick={() => pick("avatar")}>
                {t("settings.changeAvatar")}
              </Button>
              {form.avatar && (
                <Button variant="ghost" size="sm" onClick={() => setForm({ ...form, avatar: null })}>
                  {t("settings.removeAvatar")}
                </Button>
              )}
            </div>
          </Field>
          <Field label={t("settings.banner")}>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" icon={<Upload size={14} />} onClick={() => pick("banner")}>
                {t("settings.changeBanner")}
              </Button>
              {form.banner && (
                <Button variant="ghost" size="sm" onClick={() => setForm({ ...form, banner: null })}>
                  {t("settings.removeBanner")}
                </Button>
              )}
            </div>
          </Field>
          <Field label={t("settings.accent")}>
            <div className="flex items-center gap-2">
              <input type="color" value={accentHex} onChange={(e) => setForm({ ...form, accentColor: hexToColor(e.target.value) })} className="h-10 w-14 cursor-pointer rounded-lg bg-transparent" />
              {form.accentColor !== null && (
                <Button variant="ghost" size="sm" onClick={() => setForm({ ...form, accentColor: null })}>
                  {t("common.reset")}
                </Button>
              )}
            </div>
          </Field>
          <Textarea label={t("settings.bio")} placeholder={t("settings.bioPlaceholder")} value={form.bio} maxLength={1000} onChange={(e) => setForm({ ...form, bio: e.target.value })} className="min-h-32" />
        </div>
        <div>
          <div className="mb-2 text-[13px] font-semibold text-fg-3">{t("settings.preview")}</div>
          <div className="overflow-hidden rounded-2xl bg-panel shadow-lift hairline">
            <div className="h-24" style={{ background: form.banner ? undefined : form.accentColor !== null ? accentHex : "linear-gradient(120deg, rgb(var(--star)/.5), rgb(var(--sky-glow)/.7))" }}>
              {form.banner && <img src={mediaUrl(form.banner, 300)} alt="" className="h-full w-full object-cover" />}
            </div>
            <div className="px-4 pb-4">
              <div className="-mt-9 inline-block rounded-full bg-panel p-1">
                {form.avatar ? <img src={mediaUrl(form.avatar, 72)} alt="" className="h-[72px] w-[72px] rounded-full object-cover" /> : <UserAvatar userId={me.id} size={72} showStatus={false} />}
              </div>
              <div className="mt-2 rounded-xl bg-canvas/60 p-3">
                <div className="text-[17px] font-semibold">{form.displayName || me.username}</div>
                <div className="text-[13px] text-fg-3">
                  @{me.username}
                  {form.pronouns ? ` · ${form.pronouns}` : ""}
                </div>
                {form.bio && <Markdown content={form.bio} guildId={null} className="mt-2 text-[13.5px]" />}
              </div>
            </div>
          </div>
        </div>
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

// ── appearance ───────────────────────────────────────────────────────────────
const THEMES: { id: Theme; swatch: [string, string, string] }[] = [
  { id: "nova", swatch: ["#0b0d1a", "#1e233e", "#ffc35c"] },
  { id: "aurora", swatch: ["#061215", "#132d32", "#5ce8be"] },
  { id: "ember", swatch: ["#140b0f", "#321e25", "#ff8468"] },
  { id: "graphite", swatch: ["#0f1012", "#25272c", "#7a98ff"] },
  { id: "oled", swatch: ["#000000", "#18181f", "#ffc35c"] },
  { id: "daylight", swatch: ["#dfe3ef", "#fafbfe", "#cc800c"] },
];
const ACCENTS = ["#ffc35c", "#ff8468", "#ff5c9a", "#b57cff", "#7a98ff", "#4cc9f0", "#5ce8be", "#8bd450"];

function Appearance() {
  const s = useSettings();
  return (
    <>
      <SectionTitle>{t("settings.appearance")}</SectionTitle>
      <Group title={t("settings.theme")}>
        <div className="grid grid-cols-2 gap-3 py-3 sm:grid-cols-3">
          {THEMES.map((th) => (
            <button
              key={th.id}
              onClick={() => s.setSynced({ theme: th.id })}
              className={clsx("group overflow-hidden rounded-2xl text-left ring-2 transition-all", s.theme === th.id ? "ring-star" : "ring-line/10 hover:ring-line/30")}
            >
              <div className="relative h-20" style={{ background: th.swatch[0] }}>
                <div className="absolute bottom-2 left-2 right-8 top-5 rounded-lg" style={{ background: th.swatch[1] }} />
                <div className="absolute right-2 top-2 h-5 w-5 rounded-full" style={{ background: th.swatch[2], boxShadow: `0 0 14px ${th.swatch[2]}` }} />
              </div>
              <div className="flex items-center justify-between bg-panel px-3 py-2 text-[13.5px] font-semibold">
                {t(`settings.themes.${th.id}`)}
                {s.theme === th.id && <Check size={15} className="text-star" />}
              </div>
            </button>
          ))}
        </div>
      </Group>
      <Group title={t("settings.accentColor")}>
        <div className="flex flex-wrap items-center gap-2 py-3">
          <button onClick={() => s.setSynced({ accent: null })} className={clsx("rounded-lg px-3 py-1.5 text-[13px] font-semibold ring-1", !s.accent ? "bg-star/15 text-star ring-star/50" : "ring-line/15")}>
            {t("settings.accentDefault")}
          </button>
          {ACCENTS.map((c) => (
            <button key={c} onClick={() => s.setSynced({ accent: c })} className={clsx("h-8 w-8 rounded-full ring-2 ring-offset-2 ring-offset-surface transition-transform hover:scale-110", s.accent === c ? "ring-fg" : "ring-transparent")} style={{ background: c }} aria-label={c} />
          ))}
          <input type="color" value={s.accent ?? "#ffc35c"} onChange={(e) => s.setSynced({ accent: e.target.value })} className="h-8 w-10 cursor-pointer rounded-lg bg-transparent" />
        </div>
      </Group>
      <Group>
        <SettingRow title={t("settings.effects")} hint={s.effects === "full" ? t("settings.effectsFullHint") : s.effects === "lite" ? t("settings.effectsLiteHint") : t("settings.effectsOffHint")}>
          <Segmented<Effects>
            value={s.effects}
            onChange={(v) => s.setSynced({ effects: v })}
            options={[
              { value: "full", label: t("settings.effectsFull") },
              { value: "lite", label: t("settings.effectsLite") },
              { value: "off", label: t("settings.effectsOff") },
            ]}
          />
        </SettingRow>
        <SettingRow title={t("settings.density")}>
          <Segmented
            value={s.density}
            onChange={(v) => s.setSynced({ density: v })}
            options={[
              { value: "cozy", label: t("settings.cozy") },
              { value: "compact", label: t("settings.compact") },
            ]}
          />
        </SettingRow>
        <div className="py-3">
          <div className="mb-1 text-[15px] font-medium">{t("settings.fontSize")}</div>
          <Slider value={Math.round((s.fontScale || 1) * 100)} min={85} max={130} step={5} onChange={(v) => s.setSynced({ fontScale: v / 100 })} format={(v) => `${v}%`} />
        </div>
        <SettingRow title={t("settings.use24h")}>
          <Switch checked={s.use24h} onChange={(v) => s.setSynced({ use24h: v })} />
        </SettingRow>
        <SettingRow title={t("settings.animateEmoji")}>
          <Switch checked={s.animateEmoji} onChange={(v) => s.setSynced({ animateEmoji: v })} />
        </SettingRow>
        <SettingRow title={t("settings.showEmbeds")}>
          <Switch checked={s.showEmbeds} onChange={(v) => s.setSynced({ showEmbeds: v })} />
        </SettingRow>
        <SettingRow title={t("settings.sendOnEnter")} hint={t("settings.sendOnEnterHint")}>
          <Switch checked={s.sendOnEnter} onChange={(v) => s.setSynced({ sendOnEnter: v })} />
        </SettingRow>
      </Group>
    </>
  );
}

// ── voice & video ────────────────────────────────────────────────────────────
function useDevices() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const load = () => void navigator.mediaDevices?.enumerateDevices().then(setDevices).catch(() => {});
    load();
    navigator.mediaDevices?.addEventListener("devicechange", load);
    return () => navigator.mediaDevices?.removeEventListener("devicechange", load);
  }, []);
  return devices;
}

function DeviceSelect({ kind, value, onChange }: { kind: MediaDeviceKind; value: string | null; onChange: (v: string | null) => void }) {
  const devices = useDevices().filter((d) => d.kind === kind);
  return (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} className="h-10 w-full rounded-lg bg-canvas/70 px-3 outline-none ring-1 ring-line/10 focus:ring-star/60">
      <option value="">{t("settings.defaultDevice")}</option>
      {devices
        .filter((d) => d.deviceId && d.deviceId !== "default")
        .map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || d.deviceId.slice(0, 8)}
          </option>
        ))}
    </select>
  );
}

function Voice() {
  const s = useSettings();
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(-100);
  const stopRef = useRef<(() => void) | null>(null);
  const [cam, setCam] = useState<MediaStream | null>(null);
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => () => stopRef.current?.(), []);
  useEffect(() => () => cam?.getTracks().forEach((x) => x.stop()), [cam]);
  useEffect(() => {
    if (video.current && cam) video.current.srcObject = cam;
  }, [cam]);

  const toggleTest = async () => {
    if (testing) {
      stopRef.current?.();
      stopRef.current = null;
      setTesting(false);
      setLevel(-100);
      return;
    }
    try {
      stopRef.current = await startMicTest(setLevel);
      setTesting(true);
    } catch {
      toast(t("errors.microphone_denied"), "error");
    }
  };
  // Restart the test when processing settings change, so it reflects them.
  useEffect(() => {
    if (!testing) return;
    stopRef.current?.();
    void startMicTest(setLevel).then((stop) => (stopRef.current = stop));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.noise, s.inputDevice, s.echoCancellation, s.autoGain]);

  const meter = Math.max(0, Math.min(1, (level + 70) / 70));
  return (
    <>
      <SectionTitle>{t("settings.voice")}</SectionTitle>
      <div className="mb-6 grid gap-4 sm:grid-cols-2">
        <Field label={t("settings.inputDevice")}>
          <DeviceSelect kind="audioinput" value={s.inputDevice} onChange={(v) => s.setLocal({ inputDevice: v })} />
        </Field>
        <Field label={t("settings.outputDevice")}>
          <DeviceSelect
            kind="audiooutput"
            value={s.outputDevice}
            onChange={(v) => {
              s.setLocal({ outputDevice: v });
              applySink();
            }}
          />
        </Field>
        <Field label={t("settings.inputVolume")}>
          <Slider value={s.inputVolume} min={0} max={200} onChange={(v) => s.setLocal({ inputVolume: v })} format={(v) => `${v}%`} />
        </Field>
        <Field label={t("settings.outputVolume")}>
          <Slider value={s.outputVolume} min={0} max={200} onChange={(v) => s.setLocal({ outputVolume: v })} format={(v) => `${v}%`} />
        </Field>
      </div>
      <Group title={t("settings.micTest")}>
        <div className="flex items-center gap-4 py-3">
          <Button variant={testing ? "danger" : "secondary"} icon={<Mic size={15} />} onClick={() => void toggleTest()}>
            {testing ? t("settings.micTestStop") : t("settings.micTestStart")}
          </Button>
          <div className="flex h-6 flex-1 items-center gap-[3px]">
            {Array.from({ length: 40 }).map((_, i) => (
              <span key={i} className={clsx("h-full flex-1 rounded-sm transition-colors duration-75", i / 40 < meter ? (i > 32 ? "bg-bad" : i > 24 ? "bg-warn" : "bg-ok") : "bg-overlay")} />
            ))}
          </div>
        </div>
        <p className="pb-3 text-[13px] text-fg-3">{t("settings.micTestHint")}</p>
      </Group>
      <Group title={t("settings.inputMode")}>
        <div className="py-3">
          <Segmented
            value={s.inputMode}
            onChange={(v) => s.setLocal({ inputMode: v })}
            options={[
              { value: "vad", label: t("settings.vad") },
              { value: "ptt", label: t("settings.ptt") },
            ]}
          />
        </div>
        {s.inputMode === "ptt" ? (
          <SettingRow title={t("settings.pttKey")} hint={t("voice.pttHint", { key: s.pttKey })}>
            <KeyRecorder value={s.pttKey} onChange={(code) => s.setLocal({ pttKey: code })} codeMode />
          </SettingRow>
        ) : (
          <>
            <SettingRow title={t("settings.sensitivityAuto")}>
              <Switch checked={s.sensitivityAuto} onChange={(v) => s.setLocal({ sensitivityAuto: v })} />
            </SettingRow>
            {!s.sensitivityAuto && (
              <div className="py-3">
                <div className="mb-1 text-[15px] font-medium">{t("settings.sensitivity")}</div>
                <Slider value={s.sensitivityDb} min={-80} max={-10} onChange={(v) => s.setLocal({ sensitivityDb: v })} format={(v) => `${v} dB`} marker={testing ? Math.max(0, Math.min(1, (level + 80) / 70)) : undefined} />
              </div>
            )}
          </>
        )}
      </Group>
      <Group title={t("settings.processing")}>
        <SettingRow title={t("settings.noiseSuppression")}>
          <Segmented
            value={s.noise}
            onChange={(v) => s.setLocal({ noise: v })}
            options={[
              { value: "rnnoise", label: t("settings.noiseAi") },
              { value: "standard", label: t("settings.noiseStandard") },
              { value: "off", label: t("settings.noiseOff") },
            ]}
          />
        </SettingRow>
        <SettingRow title={t("settings.echoCancellation")}>
          <Switch checked={s.echoCancellation} onChange={(v) => s.setLocal({ echoCancellation: v })} />
        </SettingRow>
        <SettingRow title={t("settings.autoGain")}>
          <Switch checked={s.autoGain} onChange={(v) => s.setLocal({ autoGain: v })} />
        </SettingRow>
        <SettingRow title={t("settings.joinMuted")}>
          <Switch checked={s.joinMuted} onChange={(v) => s.setLocal({ joinMuted: v })} />
        </SettingRow>
      </Group>
      <Group title={t("settings.camera")}>
        <div className="flex flex-col gap-3 py-3">
          <DeviceSelect kind="videoinput" value={s.videoDevice} onChange={(v) => s.setLocal({ videoDevice: v })} />
          <div className="relative aspect-video w-full max-w-md overflow-hidden rounded-2xl bg-canvas hairline">
            {cam ? <video ref={video} autoPlay muted playsInline className="h-full w-full -scale-x-100 object-cover" /> : null}
            <div className="absolute inset-0 flex items-center justify-center">
              {!cam && (
                <Button
                  variant="secondary"
                  onClick={async () => {
                    try {
                      setCam(await navigator.mediaDevices.getUserMedia({ video: { deviceId: s.videoDevice ?? undefined, width: 1280, height: 720 } }));
                    } catch {
                      toast(t("errors.camera_denied"), "error");
                    }
                  }}
                >
                  {t("settings.cameraPreview")}
                </Button>
              )}
            </div>
          </div>
        </div>
      </Group>
      <Group title={t("settings.screenQuality")}>
        <div className="py-3">
          <select value={s.screenQuality} onChange={(e) => s.setLocal({ screenQuality: e.target.value as typeof s.screenQuality })} className="h-10 rounded-lg bg-canvas/70 px-3 outline-none ring-1 ring-line/10">
            <option value="720p30">720p · 30 fps</option>
            <option value="1080p30">1080p · 30 fps</option>
            <option value="1080p60">1080p · 60 fps</option>
            <option value="1440p60">1440p · 60 fps</option>
            <option value="source">{t("voice.qualitySource")} · 60 fps</option>
          </select>
          <p className="mt-1.5 text-[13px] text-fg-3">{t("settings.screenQualityHint")}</p>
        </div>
      </Group>
      <Group>
        <SettingRow title={t("settings.sounds")} hint={t("settings.soundsHint")}>
          <Switch
            checked={s.sounds}
            onChange={(v) => {
              settings().setSynced({ sounds: v });
              if (v) playSound("message", true);
            }}
          />
        </SettingRow>
      </Group>
    </>
  );
}

function KeyRecorder({ value, onChange, codeMode }: { value: string; onChange: (v: string) => void; codeMode?: boolean }) {
  const [rec, setRec] = useState(false);
  useEffect(() => {
    if (!rec) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setRec(false);
      if (codeMode) {
        onChange(e.code);
        return setRec(false);
      }
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      const combo = [e.ctrlKey && "Ctrl", e.shiftKey && "Shift", e.altKey && "Alt", e.metaKey && "Super", e.code.replace(/^Key|^Digit/, "")].filter(Boolean).join("+");
      onChange(combo);
      setRec(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [rec, onChange, codeMode]);
  return (
    <button onClick={() => setRec(true)} className={clsx("min-w-[140px] rounded-lg px-3 py-2 text-[13.5px] font-semibold ring-1", rec ? "animate-pulse bg-bad/15 text-bad ring-bad/50" : "bg-canvas/70 ring-line/15 hover:ring-star/50")}>
      {rec ? t("settings.kbPressKey") : value || "—"}
    </button>
  );
}

function Keybinds() {
  const s = useSettings();
  const setBind = (action: string, combo: string) => {
    const keybinds = { ...s.keybinds, [action]: combo };
    s.setLocal({ keybinds });
    if (isDesktop) window.nova!.setGlobalShortcuts({ toggleMute: keybinds.toggleMute ?? null, toggleDeafen: keybinds.toggleDeafen ?? null });
  };
  const rows: [string, string, React.ReactNode][] = [
    [t("settings.kbQuickSwitcher"), "", <Kbd key="k">Ctrl+K</Kbd>],
    [t("settings.kbMarkRead"), "", <Kbd key="e">Esc</Kbd>],
    [t("settings.kbEditLast"), "", <Kbd key="u">↑</Kbd>],
    [t("settings.kbNextUnread"), "", <Kbd key="a">Alt+Shift+↓</Kbd>],
  ];
  return (
    <>
      <SectionTitle sub={isDesktop ? t("settings.kbGlobal") : undefined}>{t("settings.keybinds")}</SectionTitle>
      <Group>
        <SettingRow title={t("settings.kbToggleMute")}>
          <KeyRecorder value={s.keybinds.toggleMute ?? ""} onChange={(v) => setBind("toggleMute", v)} />
        </SettingRow>
        <SettingRow title={t("settings.kbToggleDeafen")}>
          <KeyRecorder value={s.keybinds.toggleDeafen ?? ""} onChange={(v) => setBind("toggleDeafen", v)} />
        </SettingRow>
        <SettingRow title={t("settings.kbPtt")}>
          <KeyRecorder value={s.pttKey} onChange={(code) => s.setLocal({ pttKey: code })} codeMode />
        </SettingRow>
        {rows.map(([title, , kbd]) => (
          <SettingRow key={title} title={title}>
            {kbd}
          </SettingRow>
        ))}
      </Group>
    </>
  );
}

function Notifications() {
  const s = useSettings();
  const [perm, setPerm] = useState(typeof Notification !== "undefined" ? Notification.permission : "granted");
  return (
    <>
      <SectionTitle>{t("settings.notifications")}</SectionTitle>
      <Group>
        <SettingRow title={t("settings.desktopNotifications")} hint={perm === "denied" ? t("settings.notificationsBlocked") : undefined}>
          <Switch
            checked={s.desktopNotifications && perm !== "denied"}
            onChange={async (v) => {
              if (v) {
                await ensureNotificationPermission();
                setPerm(typeof Notification !== "undefined" ? Notification.permission : "granted");
              }
              s.setLocal({ desktopNotifications: v });
            }}
          />
        </SettingRow>
        <SettingRow title={t("settings.messageSounds")}>
          <Switch checked={s.sounds} onChange={(v) => s.setSynced({ sounds: v })} />
        </SettingRow>
        {isDesktop && (
          <SettingRow title={t("settings.flashTaskbar")}>
            <Switch checked={s.flashTaskbar} onChange={(v) => s.setLocal({ flashTaskbar: v })} />
          </SettingRow>
        )}
        <SettingRow title={t("settings.unreadBadge")}>
          <Switch checked={s.unreadBadge} onChange={(v) => s.setLocal({ unreadBadge: v })} />
        </SettingRow>
      </Group>
    </>
  );
}

function Sessions() {
  const [list, setList] = useState<SessionDTO[] | null>(null);
  const load = () => void api<SessionDTO[]>("/api/users/@me/sessions").then(setList).catch(() => setList([]));
  useEffect(load, []);
  const icon = (p: SessionDTO["platform"]) => (p === "mobile" ? <Smartphone size={22} /> : p === "desktop" ? <Monitor size={22} /> : <Globe size={22} />);
  return (
    <>
      <SectionTitle>{t("settings.sessions")}</SectionTitle>
      <div className="flex flex-col gap-2">
        {list?.map((sx) => (
          <div key={sx.id} className="flex items-center gap-4 rounded-2xl bg-panel p-4 hairline">
            <span className="text-fg-2">{icon(sx.platform)}</span>
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{sx.device ?? "?"}</div>
              <div className="text-[13px] text-fg-3">{sx.current ? t("settings.thisDevice") : t("settings.lastActive", { time: fmtRelative(sx.lastUsedAt) })}</div>
            </div>
            {!sx.current && (
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash2 size={14} />}
                onClick={async () => {
                  await api(`/api/users/@me/sessions/${sx.id}`, { method: "DELETE" }).catch(() => {});
                  load();
                }}
              >
                {t("settings.signOut")}
              </Button>
            )}
          </div>
        ))}
      </div>
      {list && list.length > 1 && (
        <Button
          variant="danger"
          className="mt-5"
          onClick={async () => {
            await api("/api/users/@me/sessions/revoke-others", { method: "POST" }).catch(() => {});
            load();
          }}
        >
          {t("settings.signOutOthers")}
        </Button>
      )}
    </>
  );
}

function Language() {
  const locale = useSettings((s) => s.locale);
  const opts: { id: Locale; label: string; native: string }[] = [
    { id: "ru", label: "Русский", native: "Russian" },
    { id: "en", label: "English", native: "Английский" },
  ];
  return (
    <>
      <SectionTitle>{t("settings.language")}</SectionTitle>
      <div className="flex flex-col gap-2">
        {opts.map((o) => (
          <button key={o.id} onClick={() => settings().setSynced({ locale: o.id })} className={clsx("flex items-center gap-3 rounded-2xl p-4 text-left ring-2", locale === o.id ? "bg-star/10 ring-star" : "bg-panel ring-transparent hover:bg-raised")}>
            <span className={clsx("h-4 w-4 rounded-full border-2", locale === o.id ? "border-star bg-star" : "border-fg-3")} />
            <span className="flex-1 font-semibold">{o.label}</span>
            <span className="text-[13px] text-fg-3">{o.native}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function Advanced() {
  const dev = useSettings((s) => s.developerMode);
  return (
    <>
      <SectionTitle>{t("settings.advanced")}</SectionTitle>
      <Group>
        <SettingRow title={t("settings.developerMode")} hint={t("settings.developerModeHint")}>
          <Switch checked={dev} onChange={(v) => settings().setSynced({ developerMode: v })} />
        </SettingRow>
      </Group>
    </>
  );
}

function Desktop() {
  const s = useSettings();
  return (
    <>
      <SectionTitle>{t("settings.desktop")}</SectionTitle>
      <Group>
        <SettingRow title={t("settings.autostart")}>
          <Switch
            checked={s.autostart}
            onChange={(v) => {
              s.setLocal({ autostart: v });
              window.nova?.setAutoLaunch?.(v);
            }}
          />
        </SettingRow>
        <SettingRow title={t("settings.minimizeToTray")}>
          <Switch checked={s.minimizeToTray} onChange={(v) => s.setLocal({ minimizeToTray: v })} />
        </SettingRow>
        <SettingRow title={t("settings.overlay")} hint={t("settings.overlayHint")}>
          <Switch checked={s.overlay} onChange={(v) => s.setLocal({ overlay: v })} />
        </SettingRow>
      </Group>
    </>
  );
}

function About() {
  const server = useData((s) => s.server);
  return (
    <>
      <SectionTitle>{t("settings.about")}</SectionTitle>
      <div className="rounded-2xl bg-panel p-5 hairline">
        <div className="font-display text-[18px] font-semibold">Concord Nova</div>
        <div className="mt-1 text-[14px] text-fg-2">{t("settings.version", { v: isDesktop ? window.nova!.version : __APP_VERSION__ })}</div>
        {server && <div className="text-[14px] text-fg-2">{t("settings.serverVersion", { v: `${server.name} ${server.version}` })}</div>}
      </div>
    </>
  );
}
