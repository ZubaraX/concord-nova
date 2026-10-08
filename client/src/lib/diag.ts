// Diagnostic log: what happened in calls and connections on this device —
// joins, reconnects and their reasons, connection quality, microphone errors,
// app errors. No messages, no audio, no passwords. Kept on the device (the
// last few hundred lines) and sent to the server after a call and every few
// minutes, where the instance admins can read it to look into a problem.
import { api } from "./api";
import { platform } from "./platform";

const KEY = "nova.diag";
const MAX_LINES = 800;
const MAX_ERRORS = 30;

let lines: string[] = [];
/** How many of the last lines the server hasn't got yet. */
let unsent = 0;
let errors = 0;

try {
  const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as { lines: string[]; unsent: number } | null;
  if (saved && Array.isArray(saved.lines)) {
    lines = saved.lines.slice(-MAX_LINES);
    unsent = Math.min(lines.length, Number(saved.unsent) || 0);
  }
} catch {
  /* a fresh log */
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      localStorage.setItem(KEY, JSON.stringify({ lines, unsent }));
    } catch {
      /* full or blocked: the log stays in memory */
    }
  }, 1500);
}

const clip = (s: string, n = 400) => (s.length > n ? s.slice(0, n) + "…" : s);

/** Adds a line: `area` is where (voice, gateway, app…), `data` any details worth having. */
export function diag(area: string, message: string, data?: Record<string, unknown>) {
  let extra = "";
  if (data) {
    try {
      extra = " " + clip(JSON.stringify(data), 600);
    } catch {
      /* not serialisable */
    }
  }
  lines.push(`${new Date().toISOString()} [${area}] ${clip(message)}${extra}`);
  unsent++;
  if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
  unsent = Math.min(unsent, lines.length);
  save();
}

/** Errors, from anywhere: the name and message, without flooding the log. */
export function diagError(area: string, e: unknown, data?: Record<string, unknown>) {
  if (errors >= MAX_ERRORS) return;
  errors++;
  const err = e as { name?: string; message?: string } | null;
  diag(area, `${err?.name ?? "Error"}: ${err?.message ?? String(e)}`, data);
}

/** Which app this is: version, platform, browser. */
export function clientInfo(): string {
  return clip(`Nova ${__APP_VERSION__} ${platform} · ${navigator.userAgent}`, 280);
}

/** The whole log as text, to copy. */
export function diagText(): string {
  return `${clientInfo()}\n${lines.join("\n")}\n`;
}

let flushing: Promise<void> | null = null;

/** Sends what the server hasn't got yet (quietly does nothing signed out or offline). */
export function flushDiag(): Promise<void> {
  if (flushing) return flushing;
  if (!unsent) return Promise.resolve();
  const batch = lines.slice(-unsent).slice(-500);
  flushing = api("/api/diag", { method: "POST", body: { client: clientInfo(), lines: batch } })
    .then(() => {
      unsent = Math.max(0, unsent - batch.length);
      save();
    })
    .catch(() => {})
    .finally(() => {
      flushing = null;
    });
  return flushing;
}

// App errors that nothing caught.
window.addEventListener("error", (e) => diagError("app", e.error ?? e.message, { at: e.filename ? `${e.filename.split("/").pop()}:${e.lineno}` : undefined }));
window.addEventListener("unhandledrejection", (e) => diagError("app", e.reason, { unhandled: true }));
// Every few minutes, and when the app goes to the background.
setInterval(() => void flushDiag(), 5 * 60_000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void flushDiag();
});
