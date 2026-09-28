// Tiny i18n: nested dictionaries, {var} interpolation, and Russian-style
// plural forms ("один|несколько|много" separated by "|").
import { useSyncExternalStore } from "react";
import { ru, type Dict } from "./ru";
import { en } from "./en";

export type Locale = "ru" | "en";

type DeepPartial<T> = { [K in keyof T]?: T[K] extends string ? string : T[K] extends readonly unknown[] ? T[K] : DeepPartial<T[K]> };
const dicts: Record<Locale, DeepPartial<Dict>> = { ru, en };

let locale: Locale = (() => {
  try {
    const saved = localStorage.getItem("nova.locale");
    if (saved === "ru" || saved === "en") return saved;
  } catch {
    /* ignore */
  }
  return navigator.language?.toLowerCase().startsWith("ru") || !navigator.language ? "ru" : "en";
})();

const listeners = new Set<() => void>();

export function setLocale(l: Locale) {
  if (l === locale) return;
  locale = l;
  try {
    localStorage.setItem("nova.locale", l);
  } catch {
    /* ignore */
  }
  document.documentElement.lang = l;
  listeners.forEach((fn) => fn());
}

export const getLocale = () => locale;

function lookup(dict: unknown, key: string): unknown {
  let cur = dict;
  for (const part of key.split(".")) {
    if (cur && typeof cur === "object" && part in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

export function pluralIndex(n: number, l: Locale = locale): number {
  const a = Math.abs(n);
  if (l === "ru") {
    const m10 = a % 10;
    const m100 = a % 100;
    if (m10 === 1 && m100 !== 11) return 0;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return 1;
    return 2;
  }
  return a === 1 ? 0 : 1;
}

export type Vars = Record<string, string | number>;

export function t(key: string, vars?: Vars): string {
  let raw = lookup(dicts[locale], key) ?? lookup(ru, key);
  if (typeof raw !== "string") return key;
  if (raw.includes("|") && vars && typeof vars.n === "number") {
    const forms = raw.split("|");
    raw = forms[Math.min(pluralIndex(vars.n), forms.length - 1)];
  }
  if (!vars) return raw as string;
  return (raw as string).replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

/** Raw lookup for non-string entries (tuples, arrays). */
export function tr<T = unknown>(key: string): T | undefined {
  return (lookup(dicts[locale], key) ?? lookup(ru, key)) as T | undefined;
}

/** Re-render on language switch. */
export function useLocale(): Locale {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => locale
  );
}

/** Translate an API error code (falls back to the server message / generic text). */
export function errorText(e: unknown): string {
  const err = e as { code?: string; message?: string; retryAfter?: number };
  if (err?.code) {
    const key = `errors.${err.code}`;
    const s = t(key, { s: err.retryAfter ?? 1 });
    if (s !== key) return s;
  }
  return t("errors.unknown");
}
