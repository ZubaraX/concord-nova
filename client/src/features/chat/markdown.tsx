// Discord-flavored markdown → React. Parse results are cached by content, so
// scrolling a long history never re-parses. Mentions are stored by id and
// resolved to current names at render time.
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import clsx from "clsx";
import { Copy, Check } from "lucide-react";
import { displayName, roleColor, useData } from "../../store/data";
import { navigate, useUI } from "../../store/ui";
import { inviteCodeFromUrl, mediaUrl } from "../../lib/server";
import { useSettings } from "../../store/settings";
import { isDesktop } from "../../lib/platform";
import { t } from "../../lib/i18n";

type Inline =
  | string
  | { t: "b" | "i" | "u" | "s" | "spoiler" | "sub"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "link"; url: string; c: Inline[] }
  | { t: "url"; url: string }
  | { t: "user" | "role" | "channel"; id: string }
  | { t: "everyone"; v: string }
  | { t: "emoji"; name: string; id: string; animated: boolean }
  | { t: "br" };

type Block =
  | { t: "p"; c: Inline[] }
  | { t: "quote"; c: Block[] }
  | { t: "h"; level: 1 | 2 | 3; c: Inline[] }
  | { t: "sub"; c: Inline[] }
  | { t: "ul" | "ol"; items: Inline[][]; start?: number }
  | { t: "pre"; lang: string; code: string };

const ID = "[0-9A-HJKMNP-TV-Z]{26}";
const RULES: { re: RegExp; make: (m: RegExpExecArray) => Inline }[] = [
  { re: /^\\([^A-Za-z0-9\s])/, make: (m) => m[1] },
  { re: /^`([^`\n]+?)`/, make: (m) => ({ t: "code", v: m[1] }) },
  { re: /^``([^`]+?)``/, make: (m) => ({ t: "code", v: m[1] }) },
  { re: /^\|\|([\s\S]+?)\|\|/, make: (m) => ({ t: "spoiler", c: parseInline(m[1]) }) },
  { re: /^\*\*\*([\s\S]+?)\*\*\*(?!\*)/, make: (m) => ({ t: "b", c: [{ t: "i", c: parseInline(m[1]) }] }) },
  { re: /^\*\*([\s\S]+?)\*\*(?!\*)/, make: (m) => ({ t: "b", c: parseInline(m[1]) }) },
  { re: /^__([\s\S]+?)__(?!_)/, make: (m) => ({ t: "u", c: parseInline(m[1]) }) },
  { re: /^\*(?=\S)([\s\S]*?\S)\*(?!\*)/, make: (m) => ({ t: "i", c: parseInline(m[1]) }) },
  { re: /^_(?=\S)([\s\S]*?\S)_(?![_\p{L}\p{N}])/u, make: (m) => ({ t: "i", c: parseInline(m[1]) }) },
  { re: /^~~([\s\S]+?)~~/, make: (m) => ({ t: "s", c: parseInline(m[1]) }) },
  { re: /^\[([^\]\n]{1,300})\]\((https?:\/\/[^\s)]+)\)/, make: (m) => ({ t: "link", url: m[2], c: parseInline(m[1]) }) },
  { re: /^<(https?:\/\/[^\s>]+)>/, make: (m) => ({ t: "url", url: m[1] }) },
  { re: /^https?:\/\/[^\s<]+[^\s<.,:;"'!?)\]}]/, make: (m) => ({ t: "url", url: m[0] }) },
  { re: new RegExp(`^<@!?(${ID})>`), make: (m) => ({ t: "user", id: m[1] }) },
  { re: new RegExp(`^<@&(${ID})>`), make: (m) => ({ t: "role", id: m[1] }) },
  { re: new RegExp(`^<#(${ID})>`), make: (m) => ({ t: "channel", id: m[1] }) },
  { re: new RegExp(`^<(a?):([A-Za-z0-9_]{2,32}):(${ID})>`), make: (m) => ({ t: "emoji", animated: m[1] === "a", name: m[2], id: m[3] }) },
  { re: /^@(everyone|here)(?![\w.])/, make: (m) => ({ t: "everyone", v: m[0] }) },
];
// Characters that may start a rule — plain text runs stop before them.
const SPECIAL = /[\\`|*_~[<h@]/;

function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  let text = "";
  const flush = () => {
    if (text) out.push(text);
    text = "";
  };
  outer: while (i < src.length) {
    const ch = src[i];
    if (SPECIAL.test(ch)) {
      // "_" inside words (snake_case) and "h" not starting a URL are plain text.
      const prev = src[i - 1];
      if (!(ch === "_" && prev && /[\p{L}\p{N}]/u.test(prev)) && !(ch === "h" && !src.startsWith("http", i))) {
        const rest = src.slice(i);
        for (const r of RULES) {
          const m = r.re.exec(rest);
          if (m) {
            flush();
            out.push(r.make(m as RegExpExecArray));
            i += m[0].length;
            continue outer;
          }
        }
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

function parseLines(src: string): Block[] {
  const blocks: Block[] = [];
  const lines = src.split("\n");
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push({ t: "p", c: parseInline(para.join("\n")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith(">>> ")) {
      flushPara();
      blocks.push({ t: "quote", c: parseLines([line.slice(4), ...lines.slice(i + 1)].join("\n")) });
      return blocks;
    }
    if (/^> ?/.test(line) && line !== ">") {
      flushPara();
      const quoted: string[] = [];
      while (i < lines.length && /^> ?/.test(lines[i])) quoted.push(lines[i++].replace(/^> ?/, ""));
      i--;
      blocks.push({ t: "quote", c: parseLines(quoted.join("\n")) });
      continue;
    }
    const h = /^(#{1,3}) (.+)$/.exec(line);
    if (h) {
      flushPara();
      blocks.push({ t: "h", level: h[1].length as 1 | 2 | 3, c: parseInline(h[2]) });
      continue;
    }
    const sub = /^-# (.+)$/.exec(line);
    if (sub) {
      flushPara();
      blocks.push({ t: "sub", c: parseInline(sub[1]) });
      continue;
    }
    if (/^\s*[-*] \S/.test(line) || /^\s*\d{1,3}\. \S/.test(line)) {
      flushPara();
      const ordered = /^\s*\d/.test(line);
      const items: Inline[][] = [];
      const start = ordered ? parseInt(line, 10) : undefined;
      while (i < lines.length && (ordered ? /^\s*\d{1,3}\. \S/ : /^\s*[-*] \S/).test(lines[i])) {
        items.push(parseInline(lines[i].replace(ordered ? /^\s*\d{1,3}\. / : /^\s*[-*] /, "")));
        i++;
      }
      i--;
      blocks.push({ t: ordered ? "ol" : "ul", items, start });
      continue;
    }
    para.push(line);
  }
  flushPara();
  return blocks;
}

export function parseMarkdown(src: string): Block[] {
  const out: Block[] = [];
  const re = /```(?:([\w+#.-]{1,20})\n)?([\s\S]*?)```/g;
  let last = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const before = src.slice(last, m.index).replace(/\n$/, "");
    if (before) out.push(...parseLines(before));
    out.push({ t: "pre", lang: (m[1] ?? "").toLowerCase(), code: m[2].replace(/^\n/, "").replace(/\n$/, "") });
    last = m.index + m[0].length;
    if (src[last] === "\n") last++;
  }
  const rest = src.slice(last);
  if (rest) out.push(...parseLines(rest));
  return out;
}

const cache = new Map<string, Block[]>();
function parsed(src: string): Block[] {
  let v = cache.get(src);
  if (!v) {
    v = parseMarkdown(src);
    cache.set(src, v);
    if (cache.size > 3000) cache.delete(cache.keys().next().value!);
  }
  return v;
}

// ── emoji-only detection (jumbo) ─────────────────────────────────────────────
const EMOJI_RUN = /(\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?)*|\p{Regional_Indicator}{2}|[#*0-9]️?⃣)/gu;
export function isEmojiOnly(src: string): boolean {
  const stripped = src.replace(new RegExp(`<a?:\\w{2,32}:${ID}>`, "g"), "").replace(EMOJI_RUN, "").replace(/\s+/g, "");
  if (stripped) return false;
  const count = (src.match(EMOJI_RUN)?.length ?? 0) + (src.match(new RegExp(`<a?:\\w{2,32}:${ID}>`, "g"))?.length ?? 0);
  return count > 0 && count <= 27;
}

function withEmoji(text: string, key: string): ReactNode {
  if (!/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(text)) return text;
  const parts: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(EMOJI_RUN)) {
    if (m.index! > last) parts.push(text.slice(last, m.index));
    parts.push(
      <span key={`${key}e${k++}`} className="emoji-text" title={m[0]}>
        {m[0]}
      </span>
    );
    last = m.index! + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

// ── render ───────────────────────────────────────────────────────────────────
interface Ctx {
  guildId: string | null;
}

function Spoiler({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span role="button" tabIndex={0} onClick={() => setOpen(true)} onKeyDown={(e) => e.key === "Enter" && setOpen(true)} className={clsx("spoiler", open && "revealed")}>
      <span>{children}</span>
    </span>
  );
}

function UserMention({ id, guildId }: { id: string; guildId: string | null }) {
  const name = useData((s) => (s.users[id] ? displayName(s, id, guildId) : null));
  const color = useData((s) => roleColor(s, guildId, id));
  return (
    <span className="mention" style={color ? { color, background: `${color}26` } : undefined} onClick={() => useUI.getState().setModal({ kind: "profile", userId: id, guildId })}>
      @{name ?? t("chat.unknownUser")}
    </span>
  );
}

function RoleMention({ id, guildId }: { id: string; guildId: string | null }) {
  const role = useData((s) => (guildId ? s.roles[guildId]?.[id] : undefined));
  const color = role?.color ? `#${role.color.toString(16).padStart(6, "0")}` : undefined;
  return (
    <span className="mention" style={color ? { color, background: `${color}26` } : undefined}>
      @{role?.name ?? t("chat.deletedRole")}
    </span>
  );
}

function ChannelMention({ id }: { id: string }) {
  const c = useData((s) => s.channels[id]);
  return (
    <span className="mention" onClick={() => c && navigate(c.guildId ?? "@me", c.id)}>
      #{c?.name ?? t("chat.unknownChannel")}
    </span>
  );
}

function CustomEmoji({ name, id, animated }: { name: string; id: string; animated: boolean }) {
  const url = useData((s) => {
    for (const list of Object.values(s.emojis)) {
      const e = list.find((x) => x.id === id);
      if (e) return e.url;
    }
    return null;
  });
  const animate = useSettings((s) => s.animateEmoji);
  if (!url) return <span>:{name}:</span>;
  return <img className="emoji" src={mediaUrl(url, 48)} alt={`:${name}:`} title={`:${name}:`} draggable={false} style={animated && !animate ? { animationPlayState: "paused" } : undefined} />;
}

export function openLink(url: string, e?: React.MouseEvent) {
  // An invite to this server joins right here, not in a browser tab.
  const invite = inviteCodeFromUrl(url);
  if (invite) {
    e?.preventDefault();
    useUI.getState().setModal({ kind: "acceptInvite", code: invite });
    return;
  }
  if (isDesktop) {
    e?.preventDefault();
    window.nova!.openExternal(url);
  }
}

function renderInline(nodes: Inline[], ctx: Ctx, key = "k"): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}.${i}`;
    if (typeof n === "string") return <span key={k}>{withEmoji(n, k)}</span>;
    switch (n.t) {
      case "b":
        return <strong key={k}>{renderInline(n.c, ctx, k)}</strong>;
      case "i":
        return <em key={k}>{renderInline(n.c, ctx, k)}</em>;
      case "u":
        return <u key={k}>{renderInline(n.c, ctx, k)}</u>;
      case "s":
        return <s key={k}>{renderInline(n.c, ctx, k)}</s>;
      case "sub":
        return <small key={k}>{renderInline(n.c, ctx, k)}</small>;
      case "spoiler":
        return <Spoiler key={k}>{renderInline(n.c, ctx, k)}</Spoiler>;
      case "code":
        return (
          <code key={k} className="inline">
            {n.v}
          </code>
        );
      case "link":
        return (
          <a key={k} href={n.url} target="_blank" rel="noreferrer noopener" title={n.url} onClick={(e) => openLink(n.url, e)}>
            {renderInline(n.c, ctx, k)}
          </a>
        );
      case "url":
        return (
          <a key={k} href={n.url} target="_blank" rel="noreferrer noopener" onClick={(e) => openLink(n.url, e)}>
            {n.url}
          </a>
        );
      case "user":
        return <UserMention key={k} id={n.id} guildId={ctx.guildId} />;
      case "role":
        return <RoleMention key={k} id={n.id} guildId={ctx.guildId} />;
      case "channel":
        return <ChannelMention key={k} id={n.id} />;
      case "everyone":
        return (
          <span key={k} className="mention">
            {n.v}
          </span>
        );
      case "emoji":
        return <CustomEmoji key={k} name={n.name} id={n.id} animated={n.animated} />;
      default:
        return null;
    }
  });
}

let hljsPromise: Promise<typeof import("highlight.js").default> | null = null;

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!lang && code.split("\n").length < 3) return;
    let alive = true;
    hljsPromise ??= import("highlight.js/lib/common").then((m) => m.default);
    void hljsPromise.then((hljs) => {
      if (!alive) return;
      try {
        const out = lang && hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang, ignoreIllegals: true }) : code.length < 5000 ? hljs.highlightAuto(code) : null;
        if (out) setHtml(out.value);
      } catch {
        /* plain text is fine */
      }
    });
    return () => {
      alive = false;
    };
  }, [code, lang]);
  return (
    <div className="group/code relative">
      {/* Safe: highlight.js HTML-escapes the entire source and only adds its own <span class="hljs-…"> wrappers. */}
      <pre>{html ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>}</pre>
      <button
        onClick={() => {
          void navigator.clipboard?.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
        className="absolute right-2 top-2 rounded-md bg-raised p-1.5 text-fg-2 opacity-0 transition-opacity hover:text-fg group-hover/code:opacity-100 touch-visible"
        aria-label={t("chat.copyCode")}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

function renderBlocks(blocks: Block[], ctx: Ctx, key = "b"): ReactNode[] {
  return blocks.map((b, i) => {
    const k = `${key}${i}`;
    switch (b.t) {
      case "p":
        return <span key={k}>{renderInline(b.c, ctx, k)}{i < blocks.length - 1 && blocks[i + 1].t === "p" ? "\n" : null}</span>;
      case "quote":
        return <blockquote key={k}>{renderBlocks(b.c, ctx, k)}</blockquote>;
      case "h": {
        const H = (`h${b.level}` as "h1" | "h2" | "h3");
        return <H key={k}>{renderInline(b.c, ctx, k)}</H>;
      }
      case "sub":
        return (
          <div key={k} className="text-[0.8em] text-fg-3">
            {renderInline(b.c, ctx, k)}
          </div>
        );
      case "ul":
        return (
          <ul key={k} className="list-disc">
            {b.items.map((it, j) => (
              <li key={j}>{renderInline(it, ctx, `${k}.${j}`)}</li>
            ))}
          </ul>
        );
      case "ol":
        return (
          <ol key={k} className="list-decimal" start={b.start}>
            {b.items.map((it, j) => (
              <li key={j}>{renderInline(it, ctx, `${k}.${j}`)}</li>
            ))}
          </ol>
        );
      case "pre":
        return <CodeBlock key={k} code={b.code} lang={b.lang} />;
      default:
        return null;
    }
  });
}

export const Markdown = memo(function Markdown({ content, guildId, className }: { content: string; guildId: string | null; className?: string }) {
  const blocks = parsed(content);
  const jumbo = useMemo(() => isEmojiOnly(content), [content]);
  return <div className={clsx("md", jumbo && "jumbo", className)}>{renderBlocks(blocks, { guildId })}</div>;
});

/** Plain-text preview (replies, notifications, search) with resolved names. */
export function toPlain(content: string, resolve: { user: (id: string) => string; role: (id: string) => string; channel: (id: string) => string }): string {
  return content
    .replace(new RegExp(`<@!?(${ID})>`, "g"), (_, id) => "@" + resolve.user(id))
    .replace(new RegExp(`<@&(${ID})>`, "g"), (_, id) => "@" + resolve.role(id))
    .replace(new RegExp(`<#(${ID})>`, "g"), (_, id) => "#" + resolve.channel(id))
    .replace(new RegExp(`<a?:(\\w{2,32}):${ID}>`, "g"), ":$1:")
    .replace(/```[\s\S]*?```/g, t("chat.codeStub"))
    .replace(/(\*\*|__|~~|\|\||`)/g, "");
}
