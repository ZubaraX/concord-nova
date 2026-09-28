import { ulidTime } from "@nova/shared";
import { getLocale, t } from "./i18n";

let use24h = true;
export const setUse24h = (v: boolean) => {
  use24h = v;
};

const loc = () => (getLocale() === "ru" ? "ru-RU" : "en-US");

export function fmtTime(d: Date | number | string): string {
  return new Date(d).toLocaleTimeString(loc(), { hour: "2-digit", minute: "2-digit", hour12: !use24h });
}

export function fmtDate(d: Date | number | string, withYear = true): string {
  const date = new Date(d);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(loc(), { day: "numeric", month: "long", ...(withYear && !sameYear ? { year: "numeric" } : {}) });
}

export function fmtDateTime(d: Date | number | string): string {
  return new Date(d).toLocaleString(loc(), { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: !use24h });
}

export function isSameDay(a: Date | number, b: Date | number) {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/** "Сегодня в 14:05" / "Вчера в 09:12" / "12.09.2026, 14:05" */
export function fmtMessageTime(d: Date | number | string): string {
  const date = new Date(d);
  const now = new Date();
  if (isSameDay(date, now)) return t("chat.today", { time: fmtTime(date) });
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (isSameDay(date, y)) return t("chat.yesterday", { time: fmtTime(date) });
  return date.toLocaleString(loc(), { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: !use24h });
}

export function fmtDayDivider(d: Date | number | string): string {
  const date = new Date(d);
  return date.toLocaleDateString(loc(), { day: "numeric", month: "long", year: "numeric" });
}

export function fmtRelative(d: Date | number | string): string {
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 45) return t("time.now");
  if (s < 3600) return t("time.minutesAgo", { n: Math.round(s / 60) });
  if (s < 86_400) return t("time.hoursAgo", { n: Math.round(s / 3600) });
  if (s < 7 * 86_400) return t("time.daysAgo", { n: Math.round(s / 86_400) });
  return fmtDate(d);
}

export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${t("time.hours", { n: h })} ${t("time.minutes", { n: m })}`;
  if (m) return `${t("time.minutes", { n: m })}${r ? ` ${t("time.seconds", { n: r })}` : ""}`;
  return t("time.seconds", { n: r });
}

/** 0:07 / 12:45 / 1:02:03 — timers and players. */
export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

export const idTime = (id: string) => ulidTime(id);
