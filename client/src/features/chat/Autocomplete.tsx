// Composer autocomplete for @mentions, #channels and :emoji:.
import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Hash, Volume2, AtSign } from "lucide-react";
import { Permission, type EmojiDTO } from "@nova/shared";
import { can, channelPerms, displayName, useData, type DataState } from "../../store/data";
import { loadEmoji, searchEmoji, withSkin, emojiLoaded } from "../../lib/emoji";
import { mediaUrl } from "../../lib/server";
import { UserAvatar } from "../../components/ui/avatar";

export interface Trigger {
  kind: "@" | "#" | ":";
  query: string;
  start: number;
  end: number;
}

export interface Suggestion {
  key: string;
  /** Text inserted into the composer. */
  insert: string;
  /** Token stored when sent (omit for unicode emoji). */
  token?: string;
  render: React.ReactNode;
}

export function findTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const m = /(?:^|[\s(])([@#:])([^\s@#:]{0,32})$/u.exec(before);
  if (!m) return null;
  const kind = m[1] as Trigger["kind"];
  if (kind === ":" && m[2].length < 2) return null;
  return { kind, query: m[2], start: caret - m[2].length - 1, end: caret };
}

function userSuggestions(s: DataState, channelId: string, guildId: string | null, q: string): Suggestion[] {
  const needle = q.toLowerCase();
  const ids = guildId ? Object.keys(s.members[guildId] ?? {}) : s.channels[channelId]?.recipients ?? [];
  const out: { id: string; score: number }[] = [];
  for (const id of ids) {
    const u = s.users[id];
    if (!u) continue;
    const name = displayName(s, id, guildId).toLowerCase();
    const un = u.username.toLowerCase();
    const score = !needle ? 1 : un.startsWith(needle) || name.startsWith(needle) ? 3 : un.includes(needle) || name.includes(needle) ? 2 : 0;
    if (score) out.push({ id, score: score + (s.presences[id] ? 0.5 : 0) });
  }
  const list: Suggestion[] = out
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ id }) => {
      const name = displayName(s, id, guildId);
      return {
        key: `u${id}`,
        insert: `@${name}`,
        token: `<@${id}>`,
        render: (
          <>
            <UserAvatar userId={id} size={24} />
            <span className="truncate font-semibold">{name}</span>
            <span className="truncate text-fg-3">@{s.users[id]?.username}</span>
          </>
        ),
      };
    });
  if (guildId) {
    const canEveryone = can(channelPerms(s, channelId), Permission.MENTION_EVERYONE);
    for (const r of Object.values(s.roles[guildId] ?? {})) {
      if (r.id === guildId || !(r.mentionable || canEveryone) || !r.name.toLowerCase().includes(needle)) continue;
      list.push({
        key: `r${r.id}`,
        insert: `@${r.name}`,
        token: `<@&${r.id}>`,
        render: (
          <>
            <AtSign size={18} style={{ color: r.color ? `#${r.color.toString(16).padStart(6, "0")}` : undefined }} />
            <span className="truncate font-semibold">{r.name}</span>
          </>
        ),
      });
    }
    if (canEveryone) {
      for (const v of ["everyone", "here"]) {
        if (v.startsWith(needle)) list.push({ key: v, insert: `@${v}`, render: <span className="font-semibold">@{v}</span> });
      }
    }
  }
  return list.slice(0, 10);
}

function channelSuggestions(s: DataState, guildId: string | null, q: string): Suggestion[] {
  if (!guildId) return [];
  const needle = q.toLowerCase();
  return Object.values(s.channels)
    .filter((c) => c.guildId === guildId && c.type !== "category" && c.name.toLowerCase().includes(needle))
    .slice(0, 8)
    .map((c) => ({
      key: `c${c.id}`,
      insert: `#${c.name}`,
      token: `<#${c.id}>`,
      render: (
        <>
          {c.type === "voice" ? <Volume2 size={18} className="text-fg-3" /> : <Hash size={18} className="text-fg-3" />}
          <span className="truncate font-semibold">{c.name}</span>
        </>
      ),
    }));
}

function emojiSuggestions(s: DataState, q: string): Suggestion[] {
  const needle = q.toLowerCase();
  const custom: EmojiDTO[] = Object.values(s.emojis)
    .flat()
    .filter((e) => e.name.toLowerCase().includes(needle))
    .slice(0, 5);
  const out: Suggestion[] = custom.map((e) => ({
    key: `e${e.id}`,
    insert: `:${e.name}:`,
    token: `<${e.animated ? "a" : ""}:${e.name}:${e.id}>`,
    render: (
      <>
        <img src={mediaUrl(e.url, 48)} alt="" className="h-6 w-6 object-contain" />
        <span className="truncate font-semibold">:{e.name}:</span>
      </>
    ),
  }));
  for (const e of searchEmoji(q, 10 - out.length)) {
    const ch = withSkin(e);
    out.push({
      key: `x${e.char}`,
      insert: ch,
      render: (
        <>
          <span className="text-[22px] leading-none">{ch}</span>
          <span className="truncate font-semibold">:{e.codes[0] ?? e.keywords.split("|")[0]}:</span>
        </>
      ),
    });
  }
  return out;
}

export function useSuggestions(trigger: Trigger | null, channelId: string, guildId: string | null): Suggestion[] {
  // Only the slices autocomplete reads — typing/presence churn doesn't re-render.
  const members = useData((s) => s.members);
  const users = useData((s) => s.users);
  const channels = useData((s) => s.channels);
  const emojis = useData((s) => s.emojis);
  const roles = useData((s) => s.roles);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (trigger?.kind === ":" && !emojiLoaded()) void loadEmoji().then(() => setTick((x) => x + 1));
  }, [trigger?.kind]);
  return useMemo(() => {
    if (!trigger) return [];
    const s = useData.getState();
    if (trigger.kind === "@") return userSuggestions(s, channelId, guildId, trigger.query);
    if (trigger.kind === "#") return channelSuggestions(s, guildId, trigger.query);
    return emojiSuggestions(s, trigger.query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger?.kind, trigger?.query, channelId, guildId, members, users, channels, emojis, roles, tick]);
}

export function AutocompleteList({ items, index, onPick, onHover }: { items: Suggestion[]; index: number; onPick: (s: Suggestion) => void; onHover: (i: number) => void }) {
  if (!items.length) return null;
  return (
    <div className="menu-surface absolute inset-x-0 bottom-full mb-2 max-h-80 overflow-y-auto rounded-xl p-1.5 shadow-lift anim-pop" role="listbox">
      {items.map((it, i) => (
        <button
          key={it.key}
          role="option"
          aria-selected={i === index}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(it);
          }}
          onMouseEnter={() => onHover(i)}
          className={clsx("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[14px]", i === index ? "bg-raised text-fg" : "text-fg-2")}
        >
          {it.render}
        </button>
      ))}
    </div>
  );
}
