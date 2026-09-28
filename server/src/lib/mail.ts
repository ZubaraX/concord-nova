import nodemailer from "nodemailer";
import { config } from "../config";

// One transporter, only when SMTP is configured. Without it mail is logged to
// the console so the password-reset flow is still testable in development.
const transporter =
  config.SMTP_HOST && config.SMTP_USER
    ? nodemailer.createTransport({
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        secure: config.SMTP_PORT === 465,
        auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
      })
    : null;

export const mailEnabled = !!transporter;

export async function sendMail(to: string, subject: string, text: string, html?: string): Promise<boolean> {
  if (!transporter) {
    console.log(`[mail] (SMTP not configured) → ${to}\n  ${subject}\n  ${text}`);
    return false;
  }
  try {
    await transporter.sendMail({ from: config.SMTP_FROM || config.SMTP_USER, to, subject, text, html });
    return true;
  } catch (e) {
    console.error("[mail] send failed:", (e as Error).message);
    return false;
  }
}
