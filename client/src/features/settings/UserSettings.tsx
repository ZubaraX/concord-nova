import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Monitor, Smartphone, Globe, Upload, Trash2, Mic, Check, Play, Pause } from "lucide-react";
import { hexToColor, colorToHex, UserFlags, type SessionDTO } from "@nova/shared";
import { api, uploadImage } from "../../lib/api";
import { errorText, t, useLocale, type Locale } from "../../lib/i18n";
import { toast } from "../../lib/bus";
import { fmtRelative } from "../../lib/time";
import { isDesktop } from "../../lib/platform";
import { mediaUrl } from "../../lib/server";
import { ensureNotificationPermission } from "../../lib/notifications";
import { applySink, playRingtone, playSound, resetCustomRingtone, RINGTONES, validateRingtone } from "../../lib/sound";
import { deleteAsset, putAsset } from "../../lib/assets";
import { useData } from "../../store/data";
import { logout } from "../../store/session";
import { confirmDialog } from "../../store/ui";
import { comboOf, customThemeVars, globalShortcutMap, settings, useSettings, type Theme, type Effects } from "../../store/settings";
import { AvatarDecoration, Backdrop, BACKDROPS, DECORATIONS } from "../../components/ui/cosmetics";
import { ColorButton } from "../../components/ui/ColorPicker";
import { useCustomWallpaper } from "../chat/Wallpaper";
import { Button, Input, Textarea, Switch, SettingRow, Slider, Segmented, Field, Kbd } from "../../components/ui/primitives";
import { UserAvatar } from "../../components/ui/avatar";
import { Markdown } from "../chat/markdown";
import { startMicTest } from "../voice/processor";
import { VoiceEffectsGrid } from "../voice/VoicePresets";
import { SoundboardPanel } from "../voice/Soundboard";
import { holdMicForTest, useVoice } from "../voice/voice";
import { Modal, ModalFooter, ModalHeader } from "../../components/ui/overlay";
import { SettingsLayout, SectionTitle, Group } from "./SettingsLayout";
import { AdminGuilds, AdminOverview, AdminUsers } from "./AdminSettings";

type Tab = "account" | "profile" | "appearance" | "voice" | "notifications" | "keybinds" | "sessions" | "language" | "advanced" | "desktop" | "about" | "admin-overview" | "admin-users" | "admin-guilds";

export default function UserSettings({ tab: initial, onClose }: { tab?: string; onClose: () => void }) {
  const [tab, setTab] = useState<Tab | null>((initial as Tab) ?? (window.innerWidth < 768 ? null : "account"));
  useLocale();
  const admin = useData((s) => !!s.me && (s.me.flags & UserFlags.INSTANCE_ADMIN) !== 0);
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
    ...(admin
      ? [
          {
            title: t("admin.section"),
            items: [
              { id: "admin-overview", label: t("admin.overview") },
              { id: "admin-users", label: t("admin.users") },
              { id: "admin-guilds", label: t("admin.guilds") },
            ],
          },
        ]
      : []),
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
      {admin && tab === "admin-overview" && <AdminOverview />}
      {admin && tab === "admin-users" && <AdminUsers />}
      {admin && tab === "admin-guilds" && <AdminGuilds />}
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
  const open = (m: "username" | "email" | "password") => {
    setMode(m);
    setValue(m === "username" ? me.username : "");
    setPassword("");
  };
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
              <Button size="sm" variant="secondary" onClick={() => open(r.key)}>
                {t("common.edit")}
              </Button>
            </div>
          ))}
        </div>
      </div>
      <Group title={t("settings.changePassword")}>
        <div className="py-3">
          <Button variant="secondary" onClick={() => open("password")}>
            {t("settings.changePassword")}
          </Button>
        </div>
      </Group>
      <Modal open={!!mode} onClose={() => setMode(null)} width={420}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <ModalHeader
            title={mode === "username" ? t("settings.changeUsername") : mode === "email" ? t("settings.changeEmail") : t("settings.changePassword")}
            subtitle={mode === "username" ? t("settings.usernameHint") : undefined}
          />
          <div className="flex flex-col gap-3 px-6 pb-5 pt-2">
            <Input
              label={mode === "password" ? t("settings.newPassword") : mode === "email" ? t("auth.email") : t("auth.username")}
              hint={mode === "username" ? t("errors.username_invalid") : undefined}
              type={mode === "password" ? "password" : "text"}
              value={value}
              onChange={(e) => setValue(mode === "username" ? e.target.value.toLowerCase() : e.target.value)}
              autoFocus
            />
            <Input label={t("settings.currentPassword")} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <ModalFooter>
            <Button type="button" variant="ghost" onClick={() => setMode(null)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={busy} disabled={!value || !password || (mode === "username" && value === me.username)}>
              {t("common.save")}
            </Button>
          </ModalFooter>
        </form>
      </Modal>
    </>
  );
}

// ── profile ──────────────────────────────────────────────────────────────────
function Profile() {
  const me = useData((s) => s.me)!;
  const [form, setForm] = useState({
    displayName: me.displayName ?? "",
    pronouns: me.pronouns ?? "",
    bio: me.bio ?? "",
    accentColor: me.accentColor,
    accentColor2: me.accentColor2 ?? null,
    decoration: me.decoration ?? null,
    profileEffect: me.profileEffect ?? null,
    avatar: me.avatar,
    banner: me.banner,
  });
  const [busy, setBusy] = useState(false);
  const dirty =
    form.displayName !== (me.displayName ?? "") ||
    form.pronouns !== (me.pronouns ?? "") ||
    form.bio !== (me.bio ?? "") ||
    form.accentColor !== me.accentColor ||
    form.accentColor2 !== (me.accentColor2 ?? null) ||
    form.decoration !== (me.decoration ?? null) ||
    form.profileEffect !== (me.profileEffect ?? null) ||
    form.avatar !== me.avatar ||
    form.banner !== me.banner;
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
      await api("/api/users/@me", { method: "PATCH", body: { displayName: form.displayName || null, pronouns: form.pronouns || null, bio: form.bio || null, accentColor: form.accentColor, accentColor2: form.accentColor2, decoration: form.decoration, profileEffect: form.profileEffect, avatar: form.avatar, banner: form.banner } });
      toast(t("common.saved"), "success");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const accentHex = colorToHex(form.accentColor) ?? "#ffc35c";
  const accent2Hex = colorToHex(form.accentColor2) ?? "#7a98ff";
  const gradient = form.accentColor !== null && form.accentColor2 !== null ? `linear-gradient(120deg, ${accentHex}, ${accent2Hex})` : null;
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
          <Field label={t("settings.accent")} hint={t("settings.accentHint")}>
            <div className="flex flex-wrap items-center gap-2">
              <ColorButton label={t("settings.accent")} value={accentHex} presets={ACCENTS} onChange={(hex) => setForm((f) => ({ ...f, accentColor: hexToColor(hex) }))} className={clsx(form.accentColor === null && "opacity-40")} />
              <ColorButton label={t("settings.accent2")} value={accent2Hex} presets={ACCENTS} onChange={(hex) => setForm((f) => ({ ...f, accentColor2: hexToColor(hex), accentColor: f.accentColor ?? hexToColor(accentHex) }))} className={clsx(form.accentColor2 === null && "opacity-40")} />
              {(form.accentColor !== null || form.accentColor2 !== null) && (
                <Button variant="ghost" size="sm" onClick={() => setForm({ ...form, accentColor: null, accentColor2: null })}>
                  {t("common.reset")}
                </Button>
              )}
            </div>
          </Field>
          <Field label={t("settings.decoration")}>
            <div className="grid grid-cols-5 gap-2 sm:grid-cols-8" data-decorations>
              {[null, ...DECORATIONS].map((d) => (
                <button
                  key={d ?? "none"}
                  onClick={() => setForm({ ...form, decoration: d })}
                  title={t(`settings.decorations.${d ?? "none"}`)}
                  aria-label={t(`settings.decorations.${d ?? "none"}`)}
                  aria-pressed={form.decoration === d}
                  className={clsx("flex aspect-square items-center justify-center rounded-xl ring-1 transition-colors", form.decoration === d ? "bg-star/15 ring-star/60" : "ring-line/10 hover:bg-raised")}
                >
                  <span className="relative block h-7 w-7 rounded-full bg-overlay">
                    <AvatarDecoration id={d} size={28} />
                  </span>
                </button>
              ))}
            </div>
          </Field>
          <Field label={t("settings.profileEffect")}>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4" data-profile-effects>
              {[null, ...BACKDROPS].map((b) => (
                <button
                  key={b ?? "none"}
                  onClick={() => setForm({ ...form, profileEffect: b })}
                  aria-pressed={form.profileEffect === b}
                  className={clsx("relative h-14 overflow-hidden rounded-xl bg-canvas ring-2 transition-shadow", form.profileEffect === b ? "ring-star" : "ring-line/10 hover:ring-line/30")}
                >
                  <Backdrop kind={b} />
                  <span className="absolute inset-x-0 bottom-0 truncate bg-canvas/75 px-1.5 py-0.5 text-left text-[11.5px] font-semibold">{t(`settings.backdrops.${b ?? "none"}`)}</span>
                </button>
              ))}
            </div>
          </Field>
          <Textarea label={t("settings.bio")} placeholder={t("settings.bioPlaceholder")} value={form.bio} maxLength={1000} onChange={(e) => setForm({ ...form, bio: e.target.value })} className="min-h-32" />
        </div>
        <div>
          <div className="mb-2 text-[13px] font-semibold text-fg-3">{t("settings.preview")}</div>
          <div className="relative overflow-hidden rounded-2xl bg-panel shadow-lift hairline" data-profile-preview>
            {gradient && <div className="pointer-events-none absolute inset-0" style={{ background: `linear-gradient(165deg, ${accentHex}3d, transparent 50%, ${accent2Hex}38)` }} />}
            <div className="relative h-24" style={{ background: form.banner ? undefined : (gradient ?? (form.accentColor !== null ? accentHex : "linear-gradient(120deg, rgb(var(--star)/.5), rgb(var(--sky-glow)/.7))")) }}>
              {form.banner && <img src={mediaUrl(form.banner, 300)} alt="" className="h-full w-full object-cover" />}
            </div>
            <Backdrop kind={form.profileEffect} />
            <div className="relative px-4 pb-4">
              <div className="-mt-9 inline-block rounded-full bg-panel p-1">
                <div className="relative">
                  {form.avatar ? <img src={mediaUrl(form.avatar, 72)} alt="" className="h-[72px] w-[72px] rounded-full object-cover" /> : <UserAvatar userId={me.id} size={72} showStatus={false} decor={false} />}
                  <AvatarDecoration id={form.decoration} size={72} />
                </div>
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

/** Base colours for a custom theme: deep tones and a few light ones. */
const THEME_COLORS = ["#2b3a67", "#123c3a", "#3a1f4d", "#4a1d2b", "#1f2937", "#3d2c14", "#0f3057", "#2d1b69", "#dfe7f5", "#f3e7d9", "#e3f1e5", "#f1e3ef"];

function Wallpapers() {
  const s = useSettings();
  const custom = useCustomWallpaper(!!s.wallpaperName);
  const upload = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*,video/mp4,video/webm";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      if (f.size > 30 * 1024 * 1024) return toast(t("settings.wallpaperTooBig"), "error");
      await putAsset("wallpaper", f);
      s.setLocal({ wallpaperName: f.name });
      s.setSynced({ wallpaper: "custom" });
    };
    input.click();
  };
  const tile = (id: string, label: string, body: React.ReactNode) => (
    <button key={id} onClick={() => s.setSynced({ wallpaper: id })} aria-pressed={s.wallpaper === id} className={clsx("relative h-16 overflow-hidden rounded-xl bg-canvas ring-2 transition-shadow", s.wallpaper === id ? "ring-star" : "ring-line/10 hover:ring-line/30")}>
      {body}
      <span className="absolute inset-x-0 bottom-0 truncate bg-canvas/75 px-1.5 py-0.5 text-left text-[11.5px] font-semibold">{label}</span>
    </button>
  );
  return (
    <Group title={t("settings.wallpaper")}>
      <div className="grid grid-cols-3 gap-2 py-3 sm:grid-cols-5" data-wallpapers>
        {tile("none", t("settings.backdrops.none"), null)}
        {BACKDROPS.map((b) => tile(b, t(`settings.backdrops.${b}`), <Backdrop kind={b} />))}
        {s.wallpaperName &&
          tile(
            "custom",
            s.wallpaperName,
            custom ? custom.video ? <video src={custom.url} muted loop autoPlay playsInline className="h-full w-full object-cover" /> : <img src={custom.url} alt="" className="h-full w-full object-cover" /> : null
          )}
      </div>
      <div className="flex flex-wrap items-center gap-3 pb-3">
        <Button variant="secondary" size="sm" icon={<Upload size={14} />} onClick={upload}>
          {t("settings.wallpaperUpload")}
        </Button>
        {s.wallpaperName && (
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              await deleteAsset("wallpaper");
              s.setLocal({ wallpaperName: null });
              if (s.wallpaper === "custom") s.setSynced({ wallpaper: "none" });
            }}
          >
            {t("common.remove")}
          </Button>
        )}
        <span className="text-[13px] text-fg-3">{t("settings.wallpaperHint")}</span>
      </div>
      {s.wallpaper !== "none" && (
        <div className="py-3">
          <div className="mb-1 text-[15px] font-medium">{t("settings.wallpaperDim")}</div>
          <Slider value={s.wallpaperDim} min={0} max={90} step={5} onChange={(v) => s.setSynced({ wallpaperDim: v })} format={(v) => `${v}%`} />
        </div>
      )}
    </Group>
  );
}

function Appearance() {
  const s = useSettings();
  const custom = customThemeVars(s.themeColor);
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
          <button onClick={() => s.setSynced({ theme: "custom" })} className={clsx("group overflow-hidden rounded-2xl text-left ring-2 transition-all", s.theme === "custom" ? "ring-star" : "ring-line/10 hover:ring-line/30")}>
            <div className="relative h-20" style={{ background: `rgb(${custom["--canvas"]})` }}>
              <div className="absolute bottom-2 left-2 right-8 top-5 rounded-lg" style={{ background: `rgb(${custom["--raised"]})` }} />
              <div className="absolute right-2 top-2 h-5 w-5 rounded-full" style={{ background: "conic-gradient(#f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)" }} />
            </div>
            <div className="flex items-center justify-between bg-panel px-3 py-2 text-[13.5px] font-semibold">
              {t("settings.themes.custom")}
              {s.theme === "custom" && <Check size={15} className="text-star" />}
            </div>
          </button>
        </div>
        {s.theme === "custom" && (
          <SettingRow title={t("settings.themeColor")} hint={t("settings.themeColorHint")}>
            <ColorButton label={t("settings.themeColor")} value={s.themeColor} presets={THEME_COLORS} onChange={(hex) => s.setSynced({ themeColor: hex })} />
          </SettingRow>
        )}
      </Group>
      <Group title={t("settings.accentColor")}>
        <div className="flex flex-wrap items-center gap-2 py-3">
          <button onClick={() => s.setSynced({ accent: null })} className={clsx("rounded-lg px-3 py-1.5 text-[13px] font-semibold ring-1", !s.accent ? "bg-star/15 text-star ring-star/50" : "ring-line/15")}>
            {t("settings.accentDefault")}
          </button>
          {ACCENTS.map((c) => (
            <button key={c} onClick={() => s.setSynced({ accent: c })} className={clsx("h-8 w-8 rounded-full ring-2 ring-offset-2 ring-offset-surface transition-transform hover:scale-110", s.accent === c ? "ring-fg" : "ring-transparent")} style={{ background: c }} aria-label={c} />
          ))}
          <ColorButton label={t("settings.accentPick")} value={s.accent ?? "#ffc35c"} onChange={(hex) => s.setSynced({ accent: hex })} className="!h-8 !w-10 !rounded-full" />
          <span className="text-[13px] text-fg-3">{t("settings.accentPick")}</span>
        </div>
      </Group>
      <Wallpapers />
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

/** Virtual microphones of voice changers and audio routers (VB-Cable, Voicemeeter, Voicemod, RVC clients…). */
const VIRTUAL_MIC_RE = /cable|vb-audio|voicemeeter|voicemod|virtual|w-okada|\brvc\b|clownfish|morphvox|voice ?changer/i;

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
  const releaseCall = useRef<(() => void) | null>(null);
  const inCall = useVoice((v) => v.state === "connected");
  // A virtual microphone fed by an external (AI) voice changer: our own
  // processing would only mangle its output — offer to pass it through as is.
  const inputLabel = useDevices().find((d) => d.kind === "audioinput" && d.deviceId === s.inputDevice)?.label ?? "";
  const virtualMic = VIRTUAL_MIC_RE.test(inputLabel);
  const passThrough = s.noise === "off" && !s.echoCancellation && !s.autoGain && s.voiceEffect === "none";
  const [cam, setCam] = useState<MediaStream | null>(null);
  const video = useRef<HTMLVideoElement>(null);

  useEffect(
    () => () => {
      stopRef.current?.();
      releaseCall.current?.();
    },
    []
  );
  useEffect(() => () => cam?.getTracks().forEach((x) => x.stop()), [cam]);
  useEffect(() => {
    if (video.current && cam) video.current.srcObject = cam;
  }, [cam]);

  const toggleTest = async () => {
    if (testing) {
      stopRef.current?.();
      stopRef.current = null;
      releaseCall.current?.();
      releaseCall.current = null;
      setTesting(false);
      setLevel(-100);
      return;
    }
    // Others in the call don't hear the check.
    releaseCall.current = holdMicForTest();
    try {
      stopRef.current = await startMicTest(setLevel);
      setTesting(true);
    } catch {
      releaseCall.current();
      releaseCall.current = null;
      toast(t("errors.microphone_denied"), "error");
    }
  };
  // Restart the test when processing settings change, so it reflects them.
  useEffect(() => {
    if (!testing) return;
    stopRef.current?.();
    void startMicTest(setLevel).then((stop) => (stopRef.current = stop));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.noise, s.inputDevice, s.echoCancellation, s.autoGain, s.voiceEffect]);

  const meter = Math.max(0, Math.min(1, (level + 70) / 70));
  return (
    <>
      <SectionTitle>{t("settings.voice")}</SectionTitle>
      <div className="mb-6 grid gap-4 sm:grid-cols-2">
        <Field label={t("settings.inputDevice")}>
          <DeviceSelect kind="audioinput" value={s.inputDevice} onChange={(v) => s.setLocal({ inputDevice: v })} />
          {virtualMic && (
            <div className="mt-1.5 rounded-lg bg-star/10 px-3 py-2 text-[12.5px] leading-snug text-fg-2" data-virtual-mic>
              {passThrough ? (
                t("settings.virtualMicRaw")
              ) : (
                <>
                  {t("settings.virtualMicHint")}{" "}
                  <button type="button" onClick={() => s.setLocal({ noise: "off", echoCancellation: false, autoGain: false, voiceEffect: "none" })} className="font-semibold text-star hover:underline">
                    {t("settings.virtualMicApply")}
                  </button>
                </>
              )}
            </div>
          )}
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
        <p className="pb-3 text-[13px] text-fg-3">
          {t("settings.micTestHint")}
          {inCall && <span className={clsx("block", testing && "font-semibold text-warn")}>{t("settings.micTestCall")}</span>}
        </p>
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
        <SettingRow title={t("settings.noiseSuppression")} hint={t(`settings.noiseHint.${s.noise}`)}>
          <Segmented
            value={s.noise}
            onChange={(v) => s.setLocal({ noise: v })}
            options={(["deep", "rnnoise", "standard", "off"] as const).map((v) => ({ value: v, label: t(`settings.noiseMode.${v}`) }))}
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
        <SettingRow title={t("settings.autoWatchStreams")} hint={t("settings.autoWatchStreamsHint")}>
          <Switch checked={s.autoWatchStreams} onChange={(v) => s.setLocal({ autoWatchStreams: v })} />
        </SettingRow>
        <SettingRow title={t("settings.autoLeave")} hint={t("settings.autoLeaveHint")}>
          <Segmented<typeof s.autoLeave>
            value={s.autoLeave}
            onChange={(v) => s.setSynced({ autoLeave: v })}
            options={[
              { value: "always", label: t("settings.autoLeaveAlways") },
              { value: "calls", label: t("settings.autoLeaveCalls") },
              { value: "never", label: t("settings.autoLeaveNever") },
            ]}
          />
        </SettingRow>
      </Group>
      <Group title={t("soundboard.title")}>
        <div className="py-3">
          <SoundboardPanel embedded />
        </div>
      </Group>
      <Group title={t("voice.fx.title")}>
        <VoiceEffectsGrid />
        <p className="pb-3 text-[13px] text-fg-3">{t("voice.fx.hint")}</p>
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
      if (!codeMode && (e.key === "Backspace" || e.key === "Delete") && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        onChange("");
        return setRec(false);
      }
      if (codeMode) {
        onChange(e.code);
        return setRec(false);
      }
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      onChange(comboOf(e));
      setRec(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [rec, onChange, codeMode]);
  return (
    <button onClick={() => setRec(true)} className={clsx("min-w-[140px] rounded-lg px-3 py-2 text-[13.5px] font-semibold ring-1", rec ? "animate-pulse bg-bad/15 text-bad ring-bad/50" : "bg-canvas/70 ring-line/15 hover:ring-star/50")}>
      {rec ? t("settings.kbPressKey") : value || t("settings.kbNone")}
    </button>
  );
}

function Keybinds() {
  const s = useSettings();
  const setBind = (action: string, combo: string) => {
    const keybinds = { ...s.keybinds, [action]: combo };
    s.setLocal({ keybinds });
    if (isDesktop) window.nova!.setGlobalShortcuts(globalShortcutMap(keybinds));
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
        {isDesktop && (
          <SettingRow title={t("settings.kbToggleOverlay")}>
            <KeyRecorder value={s.keybinds.toggleOverlay ?? ""} onChange={(v) => setBind("toggleOverlay", v)} />
          </SettingRow>
        )}
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
      <Ringtones />
    </>
  );
}

function Ringtones() {
  const ringtone = useSettings((s) => s.ringtone);
  const name = useSettings((s) => s.ringtoneName);
  const [playing, setPlaying] = useState<string | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const halt = () => {
    stop.current?.();
    stop.current = null;
    setPlaying(null);
  };
  useEffect(() => () => stop.current?.(), []);
  const preview = (id: string) => {
    const again = playing === id;
    halt();
    if (again) return;
    stop.current = playRingtone(id, true);
    setPlaying(id);
    setTimeout(() => setPlaying((p) => (p === id ? null : p)), id === "custom" ? 8000 : 2400);
  };
  const choose = (id: string) => settings().setLocal({ ringtone: id });
  const upload = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      if (f.size > 8 * 1024 * 1024) return toast(t("settings.ringtoneTooBig"), "error");
      const verdict = await validateRingtone(f);
      if (verdict !== "ok") return toast(t(verdict === "too_long" ? "settings.ringtoneTooLong" : "settings.ringtoneUnreadable"), "error");
      await putAsset("ringtone", f);
      resetCustomRingtone();
      settings().setLocal({ ringtone: "custom", ringtoneName: f.name });
    };
    input.click();
  };
  const row = (id: string, label: string, extra?: React.ReactNode) => (
    <div key={id} className={clsx("flex items-center gap-3 rounded-xl px-3 py-2 ring-1 transition-colors", ringtone === id ? "bg-star/10 ring-star/50" : "ring-line/10 hover:bg-raised/60")}>
      <button onClick={() => choose(id)} className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-pressed={ringtone === id}>
        <span className={clsx("h-4 w-4 shrink-0 rounded-full border-2", ringtone === id ? "border-star bg-star" : "border-fg-3")} />
        <span className="truncate font-medium">{label}</span>
      </button>
      {extra}
      <button onClick={() => preview(id)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-fg-2 hover:bg-raised hover:text-fg" aria-label={playing === id ? t("common.pause") : t("common.play")}>
        {playing === id ? <Pause size={15} /> : <Play size={15} />}
      </button>
    </div>
  );
  return (
    <Group title={t("settings.ringtone")}>
      <div className="flex flex-col gap-1.5 py-3" data-ringtones>
        {RINGTONES.map((id) => row(id, t(`settings.ringtones.${id}`)))}
        {name &&
          row(
            "custom",
            name,
            <button
              onClick={async () => {
                halt();
                await deleteAsset("ringtone");
                resetCustomRingtone();
                settings().setLocal({ ringtone: ringtone === "custom" ? "nova" : ringtone, ringtoneName: null });
              }}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-fg-3 hover:bg-bad/15 hover:text-bad"
              aria-label={t("common.delete")}
            >
              <Trash2 size={15} />
            </button>
          )}
      </div>
      <div className="flex flex-wrap items-center gap-3 pb-3">
        <Button variant="secondary" size="sm" icon={<Upload size={14} />} onClick={upload}>
          {t("settings.ringtoneUpload")}
        </Button>
        <span className="text-[13px] text-fg-3">{t("settings.ringtoneHint")}</span>
      </div>
    </Group>
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
