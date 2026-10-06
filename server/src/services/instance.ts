// Instance-wide settings an instance admin can change from the app (stored in
// the InstanceSetting table; the environment provides the defaults).
import type { RegistrationMode } from "@nova/shared";
import { prisma } from "../db";
import { config } from "../config";
import { configureMail, mailSettings, type MailSettings } from "../lib/mail";

const state: { registration: RegistrationMode; serverName: string; gifKey: string } = {
  registration: config.REGISTRATION,
  serverName: config.SERVER_NAME,
  gifKey: config.KLIPY_KEY.trim(),
};

export const instance = {
  get registration(): RegistrationMode {
    return state.registration;
  },
  get serverName(): string {
    return state.serverName;
  },
  /** KLIPY app key for GIF search; "" = search is off. */
  get gifKey(): string {
    return state.gifKey;
  },
};

const MAIL_KEYS = { host: "smtpHost", port: "smtpPort", user: "smtpUser", pass: "smtpPass", from: "smtpFrom" } as const;

export async function loadInstanceSettings() {
  const rows = await prisma.instanceSetting.findMany();
  // Mail saved from the app wins over the environment, as a whole.
  const saved = new Map(rows.map((r) => [r.key, r.value]));
  if (saved.has(MAIL_KEYS.host)) {
    configureMail({
      host: saved.get(MAIL_KEYS.host) ?? "",
      port: Number(saved.get(MAIL_KEYS.port)) || 465,
      user: saved.get(MAIL_KEYS.user) ?? "",
      pass: saved.get(MAIL_KEYS.pass) ?? "",
      from: saved.get(MAIL_KEYS.from) ?? "",
    });
  }
  for (const r of rows) {
    if (r.key === "registration" && (r.value === "open" || r.value === "invite" || r.value === "closed")) state.registration = r.value;
    if (r.key === "serverName" && r.value.trim()) state.serverName = r.value.trim();
    if (r.key === "gifKey") state.gifKey = r.value.trim();
  }
}

export async function setInstanceSettings(patch: Partial<typeof state>) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    await prisma.instanceSetting.upsert({ where: { key }, create: { key, value: String(value) }, update: { value: String(value) } });
    (state as Record<string, unknown>)[key] = value;
  }
  return { ...state };
}

/** Saves the SMTP account (`pass` undefined keeps the stored one; null turns mail off). */
export async function setMailSettings(input: { host: string; port: number; user: string; pass?: string; from?: string } | null): Promise<MailSettings> {
  const next: MailSettings = input ? { host: input.host, port: input.port, user: input.user, pass: input.pass ?? mailSettings().pass, from: input.from ?? "" } : { host: "", port: 465, user: "", pass: "", from: "" };
  for (const [field, key] of Object.entries(MAIL_KEYS)) {
    const value = String(next[field as keyof MailSettings]);
    await prisma.instanceSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }
  configureMail(next);
  return next;
}

/** What the admin panel may see of the mail account — never the password. */
export function mailOverview() {
  const m = mailSettings();
  return m.host ? { host: m.host, port: m.port, user: m.user, from: m.from, hasPassword: !!m.pass } : null;
}
