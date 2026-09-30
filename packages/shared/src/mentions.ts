// Message content tokens. Mentions are stored by id (`<@id>`), so renames never
// break them; the client renders the current name.
const ID = "[0-9A-HJKMNP-TV-Z]{26}";

export const USER_MENTION_RE = new RegExp(`<@!?(${ID})>`, "g");
export const ROLE_MENTION_RE = new RegExp(`<@&(${ID})>`, "g");
export const CHANNEL_MENTION_RE = new RegExp(`<#(${ID})>`, "g");
export const CUSTOM_EMOJI_RE = new RegExp(`<(a?):([A-Za-z0-9_]{2,32}):(${ID})>`, "g");
export const EVERYONE_RE = /(^|[^\w`])@(everyone|here)\b/;
export const URL_RE = /https?:\/\/[^\s<>"'`]+[^\s<>"'`.,:;!?)\]}]/g;

/** Remove fenced + inline code so tokens inside code are not treated as mentions. */
export function stripCode(content: string): string {
  return content.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
}

export interface ExtractedMentions {
  users: string[];
  roles: string[];
  channels: string[];
  everyone: boolean;
  here: boolean;
}

function collect(re: RegExp, text: string, group = 1): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(re)) out.add(m[group]);
  return [...out];
}

export function extractMentions(content: string): ExtractedMentions {
  const text = stripCode(content ?? "");
  const ev = EVERYONE_RE.exec(text);
  return {
    users: collect(USER_MENTION_RE, text),
    roles: collect(ROLE_MENTION_RE, text),
    channels: collect(CHANNEL_MENTION_RE, text),
    everyone: !!ev && ev[2] === "everyone",
    here: !!ev && ev[2] === "here",
  };
}

export function extractUrls(content: string, max = 5): string[] {
  const text = stripCode(content ?? "");
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    // `<https://…>` suppresses the embed, Discord-style.
    const before = text[m.index! - 1];
    if (before === "<") continue;
    if (!out.includes(m[0])) out.push(m[0]);
    if (out.length >= max) break;
  }
  return out;
}

const GIF_HOST_RE = /(^|\.)(klipy|tenor|giphy)\.com$/i;

/** Is the whole message one link to a GIF — what the GIF picker sends? Previews say "GIF" instead of the address. */
export function isGifLink(content: string): boolean {
  const s = (content ?? "").trim();
  if (!/^https?:\/\/\S+$/i.test(s)) return false;
  try {
    const u = new URL(s);
    return GIF_HOST_RE.test(u.hostname) || /\.gif$/i.test(u.pathname);
  } catch {
    return false;
  }
}

/** Reaction emoji key: a unicode emoji, or `name:id` for a custom emoji. */
export function reactionKey(emoji: { id?: string | null; name: string }): string {
  return emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name;
}

export function parseReactionKey(key: string): { id: string | null; name: string } {
  const m = /^([A-Za-z0-9_]{2,32}):([0-9A-HJKMNP-TV-Z]{26})$/.exec(key);
  return m ? { name: m[1], id: m[2] } : { name: key, id: null };
}
