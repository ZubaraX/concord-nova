import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../config";

// Outgoing mail (password-reset codes). The SMTP account comes from the
// environment (SMTP_*) or, preferably, from the app: an instance admin sets it
// in Settings → Nova server, and it is kept in the InstanceSetting table
// (services/instance.ts calls configureMail). Without it mail is only logged,
// so the reset flow is still testable in development.

export interface MailSettings {
  host: string;
  port: number;
  user: string;
  pass: string;
  /** Sender address; the account itself when empty. */
  from: string;
}

let current: MailSettings = { host: config.SMTP_HOST, port: config.SMTP_PORT, user: config.SMTP_USER, pass: config.SMTP_PASS, from: config.SMTP_FROM };
let transporter: Transporter | null = build(current);

function build(s: MailSettings): Transporter | null {
  if (!s.host || !s.user) return null;
  return nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.port === 465,
    auth: { user: s.user, pass: s.pass },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
  });
}

export function configureMail(s: MailSettings) {
  current = s;
  transporter = build(s);
}

export const mailSettings = (): MailSettings => ({ ...current });
export const mailEnabled = () => !!transporter;

/** Sends, or throws the server's reason (used by the admin's test button). */
export async function sendMailOrThrow(to: string, subject: string, text: string, html?: string) {
  if (!transporter) throw new Error("SMTP is not configured");
  await transporter.sendMail({ from: current.from || current.user, to, subject, text, html });
}

export async function sendMail(to: string, subject: string, text: string, html?: string): Promise<boolean> {
  if (!transporter) {
    console.log(`[mail] (SMTP not configured) → ${to}\n  ${subject}\n  ${text}`);
    return false;
  }
  try {
    await sendMailOrThrow(to, subject, text, html);
    return true;
  } catch (e) {
    console.error("[mail] send failed:", (e as Error).message);
    return false;
  }
}
