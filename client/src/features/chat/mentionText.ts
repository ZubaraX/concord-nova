// The composer shows readable "@Имя", "#канал", ":emoji:"; messages store
// stable id tokens. These helpers convert both ways.
import type { DataState } from "../../store/data";
import { displayName } from "../../store/data";

export interface TokenMap {
  /** visible text → token, e.g. "@Аня" → "<@01H…>" */
  [visible: string]: string;
}

const ID = "[0-9A-HJKMNP-TV-Z]{26}";

/** Tokens → readable text (for editing an existing message). */
export function tokensToText(content: string, s: DataState, guildId: string | null): { text: string; map: TokenMap } {
  const map: TokenMap = {};
  const text = content
    .replace(new RegExp(`<@!?(${ID})>`, "g"), (tok, id) => {
      const v = "@" + displayName(s, id, guildId);
      map[v] = tok;
      return v;
    })
    .replace(new RegExp(`<@&(${ID})>`, "g"), (tok, id) => {
      const v = "@" + (guildId ? s.roles[guildId]?.[id]?.name ?? "role" : "role");
      map[v] = tok;
      return v;
    })
    .replace(new RegExp(`<#(${ID})>`, "g"), (tok, id) => {
      const v = "#" + (s.channels[id]?.name ?? "channel");
      map[v] = tok;
      return v;
    })
    .replace(new RegExp(`<a?:(\\w{2,32}):${ID}>`, "g"), (tok, name) => {
      const v = `:${name}:`;
      map[v] = tok;
      return v;
    });
  return { text, map };
}

/** Readable text → tokens (on send). Also resolves hand-typed @username / #channel / :emoji:. */
export function textToTokens(text: string, map: TokenMap, s: DataState, guildId: string | null, channelId: string): string {
  let out = text;
  // Recorded insertions first, longest first so "@Аня Б" wins over "@Аня".
  for (const visible of Object.keys(map).sort((a, b) => b.length - a.length)) {
    if (out.includes(visible)) out = out.split(visible).join(map[visible]);
  }
  // Hand-typed @username (unique handles, no spaces).
  const candidates = guildId ? Object.keys(s.members[guildId] ?? {}) : s.channels[channelId]?.recipients ?? [];
  const byName = new Map<string, string>();
  for (const id of candidates) {
    const u = s.users[id];
    if (u) byName.set(u.username.toLowerCase(), id);
  }
  out = out.replace(/(^|[\s(])@([a-z0-9_.]{2,32})\b/gi, (m, pre, name) => {
    const id = byName.get(String(name).toLowerCase());
    return id ? `${pre}<@${id}>` : m;
  });
  if (guildId) {
    const chans = new Map<string, string>();
    for (const c of Object.values(s.channels)) if (c.guildId === guildId && c.type !== "category" && c.type !== "voice") chans.set(c.name.toLowerCase(), c.id);
    out = out.replace(/(^|\s)#([\p{L}\p{N}_-]{1,100})/gu, (m, pre, name) => {
      const id = chans.get(String(name).toLowerCase());
      return id ? `${pre}<#${id}>` : m;
    });
  }
  // :custom_emoji: from any of my servers.
  out = out.replace(/(?<!<a?):(\w{2,32}):(?![0-9A-Z]{26}>)/g, (m, name) => {
    for (const list of Object.values(s.emojis)) {
      const e = list.find((x) => x.name === name);
      if (e) return `<${e.animated ? "a" : ""}:${e.name}:${e.id}>`;
    }
    return m;
  });
  return out;
}
