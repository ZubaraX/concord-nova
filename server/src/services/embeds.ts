// Link previews, built in the background after a message is sent: YouTube
// (click-to-play), direct images, GIF pages and OpenGraph cards. All outbound
// fetching goes through the SSRF-safe client; external images are served via
// our signed media proxy (no mixed content, no IP leaks to third parties).
// Two exceptions: files on this very server are linked as they are, and GIFs
// from the search provider's CDN load straight from it (its terms forbid
// re-hosting, and everybody's picker talks to it anyway).
import { createHmac } from "node:crypto";
import sharp from "sharp";
import { extractUrls, type EmbedDTO, MessageFlags } from "@nova/shared";
import { prisma } from "../db";
import { config } from "../config";
import { safeFetch } from "../lib/ssrf";
import { publicUrl } from "../lib/files";
import { toChannel } from "../gateway/io";
import { loadMessage } from "./serialize";

const MAX_EMBEDS = 4;
const CACHE_TTL = 60 * 60_000;
const lru = new Map<string, { at: number; embed: EmbedDTO | null }>();

function remember(url: string, embed: EmbedDTO | null) {
  lru.set(url, { at: Date.now(), embed });
  if (lru.size > 1000) lru.delete(lru.keys().next().value!);
}

// ── signed media proxy URLs ─────────────────────────────────────────────────
const sig = (u: string) => createHmac("sha256", config.jwtSecret).update("proxy:" + u).digest("base64url").slice(0, 22);

export function proxied(url: string | null | undefined): string | null {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const u = Buffer.from(url).toString("base64url");
  return `/media-proxy?u=${u}&s=${sig(url)}`;
}

export function verifyProxy(u: string, s: string): string | null {
  try {
    const url = Buffer.from(u, "base64url").toString("utf8");
    return sig(url) === s && /^https?:\/\//i.test(url) ? url : null;
  } catch {
    return null;
  }
}

// ── parsing ─────────────────────────────────────────────────────────────────
const decodeEntities = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));

function metaTags(html: string): Map<string, string> {
  const out = new Map<string, string>();
  const head = html.slice(0, 400_000);
  for (const m of head.matchAll(/<meta\s+[^>]*>/gi)) {
    const tag = m[0];
    const key = /(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const content = /content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i.exec(tag);
    const value = content?.[1] ?? content?.[2];
    if (key && value && !out.has(key)) out.set(key, decodeEntities(value.trim()));
  }
  const title = /<title[^>]*>([^<]{1,300})<\/title>/i.exec(head)?.[1];
  if (title && !out.has("title")) out.set("title", decodeEntities(title.trim()));
  return out;
}

const clip = (s: string | undefined | null, n: number) => (s ? (s.length > n ? s.slice(0, n - 1) + "…" : s) : null);

function parseColor(v?: string): number | null {
  const m = v && /^#?([0-9a-f]{6})$/i.exec(v.trim());
  return m ? parseInt(m[1], 16) : null;
}

/** Hosts whose media the apps load directly instead of through our proxy. */
const DIRECT_MEDIA_RE = /(^|\.)klipy\.com$/i;
const mediaSrc = (url: string) => (DIRECT_MEDIA_RE.test(new URL(url).hostname) ? url : proxied(url)!);

/** A link to an image uploaded to this server — a GIF re-sent from favourites. Needs no fetch. */
async function ownFileEmbed(url: string): Promise<EmbedDTO | null> {
  let path: string;
  try {
    const u = new URL(url);
    if (!u.pathname.startsWith("/files/")) return null;
    path = decodeURIComponent(u.pathname.slice("/files/".length));
  } catch {
    return null;
  }
  const a = await prisma.attachment.findFirst({ where: { path }, select: { path: true, contentType: true, width: true, height: true } });
  if (!a?.contentType?.startsWith("image/")) return null;
  return { type: "image", url, image: { url: publicUrl(a.path), width: a.width, height: a.height } };
}

const YT_RE = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif)(\?.*)?$/i;

async function buildEmbed(url: string): Promise<EmbedDTO | null> {
  const yt = YT_RE.exec(url);
  if (yt) {
    const id = yt[1];
    let title: string | null = null;
    let author: string | null = null;
    try {
      const r = await safeFetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`, { accept: "application/json" });
      if (r.status === 200) {
        const j = JSON.parse(r.body.toString("utf8")) as { title?: string; author_name?: string };
        title = j.title ?? null;
        author = j.author_name ?? null;
      }
    } catch {
      /* title is optional */
    }
    return {
      type: "youtube",
      url,
      title: clip(title, 256),
      description: author,
      siteName: "YouTube",
      color: 0xff0000,
      thumbnail: { url: proxied(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`)!, width: 480, height: 360 },
      videoId: id,
    };
  }

  const own = await ownFileEmbed(url);
  if (own) return own;

  const res = await safeFetch(url, { maxBytes: IMAGE_EXT_RE.test(url) ? 256_000 : 1_000_000 });
  if (res.status >= 400) return null;
  const ct = res.contentType.toLowerCase();

  if (ct.startsWith("image/")) {
    let width: number | null = null;
    let height: number | null = null;
    try {
      const m = await sharp(res.body, { failOn: "none" }).metadata();
      width = m.width ?? null;
      height = m.pageHeight ?? m.height ?? null;
    } catch {
      /* partial download — dimensions unknown */
    }
    return { type: "image", url, image: { url: mediaSrc(res.url), width, height } };
  }
  if (!ct.includes("html")) return null;

  const meta = metaTags(res.body.toString("utf8"));
  const pick = (...keys: string[]) => keys.map((k) => meta.get(k)).find((v) => v);
  const abs = (v?: string) => {
    if (!v) return null;
    try {
      const u = new URL(v, res.url);
      return /^https?:$/.test(u.protocol) ? u.toString() : null;
    } catch {
      return null;
    }
  };

  const title = pick("og:title", "twitter:title", "title");
  const description = pick("og:description", "twitter:description", "description");
  const image = abs(pick("og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"));
  const video = abs(pick("og:video:secure_url", "og:video:url", "og:video"));
  const siteName = pick("og:site_name", "application-name") ?? new URL(res.url).hostname.replace(/^www\./, "");
  const iw = Number(pick("og:image:width")) || null;
  const ih = Number(pick("og:image:height")) || null;

  // GIF sites (Tenor, Giphy, KLIPY…) expose an mp4 — render as an inline looping video.
  if (video && /\.mp4(\?|$)/i.test(video) && /tenor|giphy|klipy|imgur|gfycat/i.test(res.url)) {
    return {
      type: "gifv",
      url,
      siteName,
      video: { url: video, width: Number(pick("og:video:width")) || iw, height: Number(pick("og:video:height")) || ih },
      thumbnail: image ? { url: proxied(image)!, width: iw, height: ih } : null,
    };
  }
  if (!title && !image) return null;
  const large = pick("twitter:card") === "summary_large_image";
  return {
    type: "link",
    url,
    title: clip(title, 256),
    description: clip(description, 350),
    siteName: clip(siteName, 100),
    color: parseColor(pick("theme-color")),
    image: image && large ? { url: proxied(image)!, width: iw, height: ih } : null,
    thumbnail: image && !large ? { url: proxied(image)!, width: iw, height: ih } : null,
  };
}

async function embedFor(url: string): Promise<EmbedDTO | null> {
  const hit = lru.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.embed;
  let embed: EmbedDTO | null = null;
  try {
    embed = await buildEmbed(url);
  } catch {
    embed = null;
  }
  remember(url, embed);
  return embed;
}

// ── queue ───────────────────────────────────────────────────────────────────
const queue: { messageId: string; urls: string[] }[] = [];
let running = 0;
const CONCURRENCY = 3;

export function scheduleEmbeds(messageId: string, content: string) {
  const urls = extractUrls(content, MAX_EMBEDS);
  if (!urls.length) return false;
  queue.push({ messageId, urls });
  pump();
  return true;
}

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const job = queue.shift()!;
    running++;
    void runJob(job).finally(() => {
      running--;
      pump();
    });
  }
}

async function runJob(job: { messageId: string; urls: string[] }) {
  const embeds = (await Promise.all(job.urls.map(embedFor))).filter((e): e is EmbedDTO => !!e);
  if (!embeds.length) return;
  const msg = await prisma.message.findUnique({ where: { id: job.messageId }, select: { content: true, flags: true, channelId: true } });
  if (!msg || msg.flags & MessageFlags.SUPPRESS_EMBEDS) return;
  // The message may have been edited meanwhile — keep only still-present links.
  const still = embeds.filter((e) => msg.content.includes(e.url));
  if (!still.length) return;
  await prisma.message.update({ where: { id: job.messageId }, data: { embeds: JSON.stringify(still) } });
  const dto = await loadMessage(job.messageId);
  if (dto) toChannel(msg.channelId, "MESSAGE_UPDATE", dto);
}
