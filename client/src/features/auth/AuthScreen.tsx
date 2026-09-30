import { useEffect, useMemo, useState, type FormEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, Globe, KeyRound } from "lucide-react";
import { loginSchema, registerSchema, issuesToFields, type InviteDTO, type ServerInfoDTO } from "@nova/shared";
import { api, ApiError } from "../../lib/api";
import { errorText, t } from "../../lib/i18n";
import { canChangeServer, hasServer, normalizeServer, serverBase, setServerBase } from "../../lib/server";
import { pendingInvite } from "../../lib/deeplink";
import { OpenInApp } from "../../components/ui/OpenInApp";
import { login, register } from "../../store/session";
import { Button, Input } from "../../components/ui/primitives";
import { NovaStar, Wordmark } from "../../components/Logo";
import { GuildIcon } from "../../components/ui/avatar";
import { mediaUrl } from "../../lib/server";

type Mode = "login" | "register" | "forgot" | "reset";


function fieldText(code: string | undefined): string | null {
  if (!code) return null;
  const s = t(`errors.${code}`);
  return s.startsWith("errors.") ? t("errors.validation_failed") : s;
}

export function AuthScreen() {
  // Captured by lib/deeplink (a /invite/CODE link) before the router rewrote the URL.
  const [inviteFromUrl] = useState(pendingInvite);
  const [mode, setMode] = useState<Mode>(inviteFromUrl ? "register" : "login");
  const [needServer, setNeedServer] = useState(!hasServer());
  const [info, setInfo] = useState<ServerInfoDTO | null>(null);
  const [invite, setInvite] = useState<InviteDTO | null>(null);

  // Explain a dead end instead of failing on submit: server unreachable, or
  // reachable but not running Concord Nova yet (e.g. the old Concord).
  const [serverIssue, setServerIssue] = useState<"down" | "old" | null>(null);
  useEffect(() => {
    if (needServer) return;
    setServerIssue(null);
    api<ServerInfoDTO>("/api/auth/info", { auth: false })
      .then((i) => setInfo(i))
      .catch((e) => {
        setInfo(null);
        setServerIssue(e instanceof ApiError && e.status > 0 && e.status < 500 ? "old" : "down");
      });
    if (inviteFromUrl) api<InviteDTO>(`/api/invites/${inviteFromUrl}`, { auth: false }).then(setInvite).catch(() => {});
  }, [needServer]);

  return (
    <div className="flex h-full overflow-y-auto">
      <div className="mx-auto grid w-full max-w-6xl items-center gap-10 px-5 py-10 lg:grid-cols-[1.1fr_1fr] lg:px-10">
        <Hero />
        <div className="w-full max-w-[440px] justify-self-center lg:justify-self-end">
          <div className="glass rounded-[22px] p-7 shadow-lift sm:p-8">
            {serverIssue && !needServer && (
              <div role="alert" className="mb-5 rounded-xl bg-bad/10 px-4 py-3 text-[13px] leading-relaxed text-fg ring-1 ring-bad/30">
                <div className="font-semibold">{t(serverIssue === "old" ? "auth.serverOldTitle" : "auth.serverDownTitle")}</div>
                <div className="mt-1 text-fg-2">
                  {t(serverIssue === "old" ? "auth.serverOldText" : "auth.serverDownText", { host: (serverBase() || location.origin).replace(/^https?:\/\//, "") })}
                </div>
              </div>
            )}
            {invite && <InviteBanner invite={invite} />}
            {inviteFromUrl && <OpenInApp code={inviteFromUrl} downloads={info?.downloads} className="-mt-3 mb-5" />}
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={needServer ? "server" : mode} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.18 }}>
                {needServer ? (
                  <ServerForm onDone={() => setNeedServer(false)} />
                ) : mode === "login" ? (
                  <LoginForm setMode={setMode} />
                ) : mode === "register" ? (
                  <RegisterForm setMode={setMode} info={info} invite={inviteFromUrl} />
                ) : (
                  <ForgotForm setMode={setMode} mode={mode} />
                )}
              </motion.div>
            </AnimatePresence>
          </div>
          {canChangeServer() && !needServer && (
            <button onClick={() => setNeedServer(true)} className="mx-auto mt-4 flex items-center gap-1.5 text-[13px] text-fg-3 transition-colors hover:text-fg-2">
              <Globe size={14} /> {serverBase().replace(/^https?:\/\//, "") || location.host} · {t("auth.serverChange")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <div className="max-lg:text-center">
      <div className="flex items-center gap-3 max-lg:justify-center">
        <NovaStar size={44} glow />
        <Wordmark className="text-xl" />
      </div>
      <h1 className="mt-8 font-display text-[clamp(30px,5vw,58px)] font-semibold leading-[1.02] tracking-[-0.035em] text-fg max-lg:hidden">
        {t("auth.heroTitle")
          .split("\n")
          .map((line, i) => (
            <span key={i} className="block">
              {line}
            </span>
          ))}
      </h1>
      <p className="mt-5 max-w-md text-[16px] leading-relaxed text-fg-2 max-lg:mx-auto max-lg:hidden">
        {t("auth.heroText")}
      </p>
    </div>
  );
}

function InviteBanner({ invite }: { invite: InviteDTO }) {
  return (
    <div className="mb-6 flex items-center gap-3 rounded-2xl bg-star/10 p-3 ring-1 ring-star/25">
      <GuildIcon guildId={invite.guild.id} name={invite.guild.name} icon={invite.guild.icon} size={44} active />
      <div className="min-w-0">
        <div className="text-[12.5px] text-fg-2">{t("guild.youWereInvited")}</div>
        <div className="truncate font-semibold">{invite.guild.name}</div>
        <div className="text-[12px] text-fg-3">
          {t("guild.onlineCount", { n: invite.guild.onlineCount })} · {t("guild.memberCount", { n: invite.guild.memberCount })}
        </div>
      </div>
      {invite.guild.banner && <img src={mediaUrl(invite.guild.banner, 96)} alt="" className="ml-auto h-10 w-16 rounded-lg object-cover" />}
    </div>
  );
}

function Title({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-6">
      <h2 className="font-display text-[24px] font-semibold tracking-[-0.02em]">{title}</h2>
      <p className="mt-1.5 text-[15px] text-fg-2">{subtitle}</p>
    </div>
  );
}

function FormError({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="rounded-xl bg-bad/12 px-3.5 py-2.5 text-[14px] text-bad ring-1 ring-bad/25">{error}</div>;
}

function LoginForm({ setMode }: { setMode: (m: Mode) => void }) {
  const [form, setForm] = useState({ login: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = loginSchema.safeParse(form);
    if (!v.success) return setError(t("errors.validation_failed"));
    setBusy(true);
    setError(null);
    try {
      await login(v.data.login, v.data.password);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Title title={t("auth.loginTitle")} subtitle={t("auth.loginSubtitle")} />
      <Input label={t("auth.login")} autoComplete="username" autoFocus value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} />
      <Input label={t("auth.password")} type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
      <button type="button" onClick={() => setMode("forgot")} className="-mt-2 self-start text-[13px] text-sky hover:underline">
        {t("auth.forgot")}
      </button>
      <FormError error={error} />
      <Button type="submit" size="lg" block loading={busy}>
        {t("auth.signIn")}
      </Button>
      <p className="text-center text-[14px] text-fg-3">
        {t("auth.noAccount")}{" "}
        <button type="button" onClick={() => setMode("register")} className="font-semibold text-sky hover:underline">
          {t("auth.toRegister")}
        </button>
      </p>
    </form>
  );
}

function RegisterForm({ setMode, info, invite }: { setMode: (m: Mode) => void; info: ServerInfoDTO | null; invite: string | null }) {
  const [form, setForm] = useState({ username: "", displayName: "", email: "", password: "", invite: invite ?? "" });
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const needInvite = info?.registration === "invite" && !invite;
  const closed = info?.registration === "closed";

  // Suggest a username from the display name as the user types.
  const suggested = useMemo(() => {
    const map: Record<string, string> = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ы: "y", э: "e", ю: "yu", я: "ya" };
    return form.displayName
      .toLowerCase()
      .split("")
      .map((c) => map[c] ?? c)
      .join("")
      .replace(/[^a-z0-9_.]+/g, "_")
      .replace(/^[._]+|[._]+$/g, "")
      .slice(0, 32);
  }, [form.displayName]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const input = { ...form, username: form.username || suggested, displayName: form.displayName || undefined, invite: form.invite || undefined };
    const v = registerSchema.safeParse(input);
    if (!v.success) {
      setFields(issuesToFields(v.error.issues));
      return;
    }
    setFields({});
    setBusy(true);
    setError(null);
    try {
      const joined = await register(v.data);
      if (joined) location.hash = `#/channels/${joined}`;
    } catch (err) {
      const e2 = err as ApiError;
      if (e2.code === "username_taken") setFields({ username: "username_taken" });
      else if (e2.code === "email_taken") setFields({ email: "email_taken" });
      else if (e2.fields) setFields(e2.fields);
      else setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Title title={t("auth.registerTitle")} subtitle={t("auth.registerSubtitle")} />
      {closed && <FormError error={t("errors.registration_closed")} />}
      <Input label={t("auth.displayName")} hint={t("auth.displayNameHint")} autoFocus value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
      <Input
        label={t("auth.username")}
        hint={t("auth.usernameHint")}
        placeholder={suggested || "alex_99"}
        autoComplete="username"
        value={form.username}
        error={fieldText(fields.username)}
        onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })}
      />
      <Input label={t("auth.email")} type="email" autoComplete="email" value={form.email} error={fieldText(fields.email)} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      <Input label={t("auth.password")} type="password" autoComplete="new-password" value={form.password} error={fieldText(fields.password)} onChange={(e) => setForm({ ...form, password: e.target.value })} />
      {needInvite && (
        <Input label={t("auth.invite")} hint={t("auth.inviteHint")} value={form.invite} right={<KeyRound size={16} className="text-fg-3" />} onChange={(e) => setForm({ ...form, invite: e.target.value.trim().replace(/^.*\/invite\//, "") })} />
      )}
      <FormError error={error} />
      <Button type="submit" size="lg" block loading={busy} disabled={closed}>
        {t("auth.signUp")}
      </Button>
      <p className="text-center text-[14px] text-fg-3">
        {t("auth.haveAccount")}{" "}
        <button type="button" onClick={() => setMode("login")} className="font-semibold text-sky hover:underline">
          {t("auth.toLogin")}
        </button>
      </p>
    </form>
  );
}

function ForgotForm({ setMode, mode }: { setMode: (m: Mode) => void; mode: Mode }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/forgot", { method: "POST", body: { email }, auth: false });
      setMsg(t("auth.codeSent"));
      setMode("reset");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const reset = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/reset", { method: "POST", body: { email, code, password }, auth: false });
      setMsg(t("auth.resetDone"));
      setTimeout(() => setMode("login"), 1600);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={mode === "forgot" ? send : reset} className="flex flex-col gap-4">
      <button type="button" onClick={() => setMode("login")} className="-mt-1 flex items-center gap-1 self-start text-[13px] text-fg-3 hover:text-fg">
        <ArrowLeft size={14} /> {t("common.back")}
      </button>
      <Title title={t("auth.forgotTitle")} subtitle={t("auth.forgotSubtitle")} />
      <Input label={t("auth.email")} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus={mode === "forgot"} />
      {mode === "reset" && (
        <>
          <Input label={t("auth.code")} value={code} autoFocus onChange={(e) => setCode(e.target.value.toUpperCase())} className="font-mono tracking-[0.2em]" />
          <Input label={t("auth.newPassword")} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </>
      )}
      {msg && <div className="rounded-xl bg-ok/12 px-3.5 py-2.5 text-[14px] text-ok ring-1 ring-ok/25">{msg}</div>}
      <FormError error={error} />
      <Button type="submit" size="lg" block loading={busy}>
        {mode === "forgot" ? t("auth.sendCode") : t("auth.resetPassword")}
      </Button>
    </form>
  );
}

function ServerForm({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState(serverBase());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const url = normalizeServer(value);
    if (!url) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(url + "/api/auth/info", { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error();
      setServerBase(url);
      onDone();
    } catch {
      setError(t("errors.network_error"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Title title={t("auth.server")} subtitle={t("auth.tagline")} />
      <Input label={t("auth.server")} placeholder={t("auth.serverHint")} value={value} autoFocus onChange={(e) => setValue(e.target.value)} right={<Globe size={16} className="text-fg-3" />} />
      <FormError error={error} />
      <Button type="submit" size="lg" block loading={busy}>
        {t("common.next")}
      </Button>
    </form>
  );
}
