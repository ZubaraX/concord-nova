import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import clsx from "clsx";
import { Download, FileText, Play, Pause, SmilePlus, MessagesSquare, Check } from "lucide-react";
import { AttachmentFlags, MessageFlags, formatBytes, parseReactionKey, type AttachmentDTO, type EmbedDTO, type MessageDTO, type PollDTO, type ReactionDTO } from "@nova/shared";
import { api } from "../../lib/api";
import { errorText, t } from "../../lib/i18n";
import { toast } from "../../lib/bus";
import { mediaUrl } from "../../lib/server";
import { fmtClock } from "../../lib/time";
import { displayName, useData } from "../../store/data";
import { useUI } from "../../store/ui";
import { useSettings } from "../../store/settings";
import { Popover, Tooltip, usePopover } from "../../components/ui/overlay";
import { EmojiPicker } from "./EmojiPicker";
import { FavoriteStar } from "./GifPicker";
import { instantGif, knownGifSize, loneUrl, looksLikeGif } from "../../lib/gifs";
import { openLink } from "./markdown";

// ── attachments ─────────────────────────────────────────────────────────────
const isImage = (a: AttachmentDTO) => !!a.contentType?.startsWith("image/");
const isVideo = (a: AttachmentDTO) => !!a.contentType?.startsWith("video/");
const isVoice = (a: AttachmentDTO) => !!(a.flags & AttachmentFlags.VOICE_MESSAGE);
const isAudio = (a: AttachmentDTO) => !!a.contentType?.startsWith("audio/") && !isVoice(a);

/**
 * A media frame that keeps the picture's proportions and never outgrows the
 * chat: at most `maxW` × `maxH` px, the chat's width, and `tall` of the chat's
 * height (the message list is a size container — next to a call it is narrow
 * and short). `px` is the widest it can get, for picking a resized variant.
 */
function frame(w: number | null, h: number | null, maxW: number, maxH: number, tall = 0.6): { style: React.CSSProperties; px: number } {
  const r = w && h ? w / h : 5 / 3;
  const px = Math.max(40, Math.round(w && h ? Math.min(w, maxW, maxH * r) : maxW));
  return { style: { width: `min(${px}px, 100%, ${(tall * 100 * r).toFixed(2)}cqh)`, aspectRatio: String(r) }, px };
}

function SpoilerCover({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  if (open) return <>{children}</>;
  return (
    <button onClick={() => setOpen(true)} className="relative block overflow-hidden rounded-xl">
      <div className="pointer-events-none blur-2xl">{children}</div>
      <span className="absolute inset-0 flex items-center justify-center bg-canvas/40">
        <span className="rounded-full bg-canvas/90 px-3 py-1 text-[12px] font-bold text-fg">{t("chat.spoilerBadge")}</span>
      </span>
    </button>
  );
}

export const Attachments = memo(function Attachments({ items }: { items: AttachmentDTO[] }) {
  const media = items.filter((a) => isImage(a) || isVideo(a));
  const rest = items.filter((a) => !(isImage(a) || isVideo(a)));
  const openLightbox = (i: number) =>
    useUI.setState({
      lightbox: {
        index: i,
        items: media.map((m) => ({ url: mediaUrl(m.url)!, name: m.filename, type: isVideo(m) ? "video" : "image", width: m.width, height: m.height })),
      },
    });
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      {media.length === 1 && <MediaItem a={media[0]} single onOpen={() => openLightbox(0)} />}
      {media.length > 1 && (
        <div className={clsx("grid max-w-[520px] gap-1", media.length === 2 || media.length === 4 ? "grid-cols-2" : "grid-cols-3")}>
          {media.map((m, i) => (
            <MediaItem key={m.id} a={m} onOpen={() => openLightbox(i)} />
          ))}
        </div>
      )}
      {rest.map((a) => (isVoice(a) ? <VoicePlayer key={a.id} a={a} /> : isAudio(a) ? <AudioCard key={a.id} a={a} /> : <FileCard key={a.id} a={a} />))}
    </div>
  );
});

function MediaItem({ a, single, onOpen }: { a: AttachmentDTO; single?: boolean; onOpen: () => void }) {
  const animate = useSettings((s) => s.animateEmoji);
  const size = single ? frame(a.width, a.height, 520, 360) : null;
  const gif = a.contentType === "image/gif";
  const image = (
    <button onClick={onOpen} className={clsx("block overflow-hidden rounded-xl bg-raised", !single && "aspect-square w-full", single && gif && "h-full w-full")} style={single && !gif ? size?.style : undefined}>
      <img
        src={gif && animate ? mediaUrl(a.url) : mediaUrl(a.url, single ? (size?.px ?? 520) : 260)}
        alt={a.filename}
        loading="lazy"
        decoding="async"
        draggable={false}
        className="h-full w-full object-cover transition-transform duration-300 hover:scale-[1.02]"
      />
    </button>
  );
  const el = isVideo(a) ? (
    <video src={mediaUrl(a.url)} controls preload="metadata" className={clsx("rounded-xl bg-canvas", single ? "max-w-full" : "aspect-square w-full object-cover")} style={size?.style} />
  ) : gif ? (
    <div className={clsx("group/gif relative", single && "max-w-full")} style={size?.style}>
      {image}
      <FavoriteStar gif={{ url: a.url, width: a.width, height: a.height }} />
    </div>
  ) : (
    image
  );
  return a.flags & AttachmentFlags.SPOILER ? <SpoilerCover>{el}</SpoilerCover> : el;
}

function FileCard({ a }: { a: AttachmentDTO }) {
  return (
    <div className="flex w-full max-w-[420px] items-center gap-3 rounded-xl bg-raised/70 p-3 hairline">
      <FileText size={32} className="shrink-0 text-star" />
      <div className="min-w-0 flex-1">
        <a href={mediaUrl(a.url) + "?download=1"} download={a.filename} className="block truncate text-[14.5px] font-medium text-sky hover:underline" onClick={(e) => openLink(mediaUrl(a.url) + "?download=1", e)}>
          {a.filename}
        </a>
        <div className="text-[12px] text-fg-3">{formatBytes(a.size)}</div>
      </div>
      <a href={mediaUrl(a.url) + "?download=1"} download={a.filename} className="rounded-lg p-2 text-fg-2 hover:bg-overlay hover:text-fg" aria-label={t("common.download")} onClick={(e) => openLink(mediaUrl(a.url) + "?download=1", e)}>
        <Download size={18} />
      </a>
    </div>
  );
}

function AudioCard({ a }: { a: AttachmentDTO }) {
  return (
    <div className="w-full max-w-[420px] rounded-xl bg-raised/70 p-3 hairline">
      <div className="mb-2 truncate text-[14px] font-medium">{a.filename}</div>
      <audio src={mediaUrl(a.url)} controls preload="metadata" className="w-full" />
    </div>
  );
}

const RATES = [1, 1.5, 2];

function VoicePlayer({ a }: { a: AttachmentDTO }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [rate, setRate] = useState(1);
  const bars = useMemo(() => {
    try {
      const raw = atob(a.waveform ?? "");
      const arr = Array.from(raw, (c) => c.charCodeAt(0) / 255);
      return arr.length ? arr : Array(40).fill(0.3);
    } catch {
      return Array(40).fill(0.3);
    }
  }, [a.waveform]);
  const duration = a.duration ?? 0;
  useEffect(() => () => audio.current?.pause(), []);
  const toggle = () => {
    if (!audio.current) {
      const el = new Audio(mediaUrl(a.url));
      el.playbackRate = rate;
      el.ontimeupdate = () => setPos(el.currentTime);
      el.onended = () => {
        setPlaying(false);
        setPos(0);
      };
      audio.current = el;
    }
    if (playing) audio.current.pause();
    else void audio.current.play();
    setPlaying(!playing);
  };
  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = (e.clientX - r.left) / r.width;
    if (!audio.current) toggle();
    if (audio.current) audio.current.currentTime = f * (duration || audio.current.duration || 0);
  };
  const progress = duration ? pos / duration : 0;
  return (
    <div className="flex w-full max-w-[380px] items-center gap-3 rounded-full bg-raised/80 py-1.5 pl-1.5 pr-3 hairline">
      <button onClick={toggle} className="star-fill flex h-9 w-9 shrink-0 items-center justify-center rounded-full" aria-label={playing ? t("common.pause") : t("common.play")}>
        {playing ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
      </button>
      <div className="flex h-8 flex-1 cursor-pointer items-center gap-[2px]" onClick={seek}>
        {bars.map((b, i) => (
          <span key={i} className={clsx("w-[3px] flex-1 rounded-full transition-colors", i / bars.length <= progress ? "bg-star" : "bg-fg-3/50")} style={{ height: `${Math.max(14, b * 100)}%` }} />
        ))}
      </div>
      <span className="w-10 shrink-0 text-right text-[12px] tabular-nums text-fg-2">{fmtClock(playing || pos ? pos : duration)}</span>
      <button
        onClick={() => {
          const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
          setRate(next);
          if (audio.current) audio.current.playbackRate = next;
        }}
        className="shrink-0 rounded-md bg-canvas/70 px-1.5 text-[11px] font-bold text-fg-2"
      >
        {rate}×
      </button>
    </div>
  );
}

// ── embeds ──────────────────────────────────────────────────────────────────
export interface LoneMedia {
  /** The link text is left out: the picture says it all. */
  hideText: boolean;
  /** Shown by the app itself, before (or without) the server's preview. */
  instant: { src: string; key: string; link: string } | null;
}
const NO_LONE: LoneMedia = { hideText: false, instant: null };

/** A message that is nothing but a link to a GIF or a picture — what the GIF picker sends. */
export function useLoneMedia(m: MessageDTO): LoneMedia {
  const show = useSettings((s) => s.showEmbeds);
  return useMemo(() => {
    if (!show || m.flags & MessageFlags.SUPPRESS_EMBEDS) return NO_LONE;
    const link = loneUrl(m.content);
    if (!link) return NO_LONE;
    if (m.embeds.some((e) => e.url === link && ((e.type === "image" && e.image) || (e.type === "gifv" && e.video)))) return { hideText: true, instant: null };
    const instant = instantGif(link);
    return instant ? { hideText: true, instant: { ...instant, link } } : NO_LONE;
  }, [show, m.flags, m.content, m.embeds]);
}

export function InstantGif({ src, link, favKey }: { src: string; link: string; favKey: string }) {
  const [dims, setDims] = useState(() => knownGifSize(link));
  const [failed, setFailed] = useState(false);
  const url = mediaUrl(src)!;
  if (failed) {
    return (
      <a href={link} target="_blank" rel="noreferrer noopener" onClick={(e) => openLink(link, e)} className="break-all text-[15.5px] text-sky hover:underline">
        {link}
      </a>
    );
  }
  return (
    <div className="group/gif relative mt-1 max-w-full" style={frame(dims?.width ?? null, dims?.height ?? null, 420, 320).style}>
      <button
        onClick={() => useUI.setState({ lightbox: { index: 0, items: [{ url, type: "image", width: dims?.width, height: dims?.height }] } })}
        className="block h-full w-full overflow-hidden rounded-xl bg-raised"
      >
        <img
          src={url}
          alt=""
          draggable={false}
          onLoad={(e) => !dims && setDims({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
          onError={() => setFailed(true)}
          className={clsx("h-full w-full", dims ? "object-cover" : "object-contain")}
        />
      </button>
      <FavoriteStar gif={{ url: favKey, width: dims?.width, height: dims?.height }} />
    </div>
  );
}

export const Embeds = memo(function Embeds({ items }: { items: EmbedDTO[] }) {
  const show = useSettings((s) => s.showEmbeds);
  if (!show) return null;
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      {items.map((e, i) => (
        <Embed key={i} e={e} />
      ))}
    </div>
  );
});

function Embed({ e }: { e: EmbedDTO }) {
  const [playing, setPlaying] = useState(false);
  if (e.type === "image" && e.image) {
    const size = frame(e.image.width ?? null, e.image.height ?? null, 420, 320);
    // Uploaded files are starred by their path on this server, everything else by its link.
    const own = e.image.url.startsWith("/files/");
    return (
      <div className="group/gif relative max-w-full" style={size.style}>
        <button
          onClick={() => useUI.setState({ lightbox: { index: 0, items: [{ url: mediaUrl(e.image!.url)!, type: "image", width: e.image!.width, height: e.image!.height }] } })}
          className="block h-full w-full overflow-hidden rounded-xl bg-raised"
        >
          <img src={mediaUrl(e.image.url)} alt="" loading="lazy" className="h-full w-full object-cover" />
        </button>
        {looksLikeGif(e.url) && <FavoriteStar gif={{ url: own ? e.image.url : e.url, preview: own ? null : e.image.url, width: e.image.width, height: e.image.height }} />}
      </div>
    );
  }
  if (e.type === "gifv" && e.video) {
    const size = frame(e.video.width ?? null, e.video.height ?? null, 400, 300);
    return (
      <div className="group/gif relative max-w-full" style={size.style}>
        <video src={e.video.url} autoPlay loop muted playsInline className="h-full w-full rounded-xl bg-raised object-cover" poster={mediaUrl(e.thumbnail?.url)} />
        <FavoriteStar gif={{ url: e.url, preview: e.thumbnail?.url, width: e.video.width, height: e.video.height }} />
      </div>
    );
  }
  const color = e.color ? `#${e.color.toString(16).padStart(6, "0")}` : "rgb(var(--overlay))";
  return (
    <div className="grid max-w-[480px] gap-2 overflow-hidden rounded-xl bg-raised/70 py-3 pl-4 pr-3 hairline" style={{ borderLeft: `4px solid ${color}` }}>
      <div className="flex gap-3">
        <div className="min-w-0 flex-1">
          {e.siteName && <div className="mb-1 text-[12px] text-fg-3">{e.siteName}</div>}
          {e.title && (
            <a href={e.url} target="_blank" rel="noreferrer noopener" onClick={(ev) => openLink(e.url, ev)} className="line-clamp-2 text-[15px] font-semibold text-sky hover:underline">
              {e.title}
            </a>
          )}
          {e.description && <p className="mt-1 line-clamp-4 whitespace-pre-line text-[13.5px] leading-snug text-fg-2">{e.description}</p>}
        </div>
        {e.thumbnail && e.type !== "youtube" && <img src={mediaUrl(e.thumbnail.url)} alt="" loading="lazy" className="h-20 w-20 shrink-0 rounded-lg object-cover" />}
      </div>
      {e.type === "youtube" && e.videoId && (
        <div className="relative aspect-video w-full max-w-[440px] overflow-hidden rounded-lg bg-canvas">
          {playing ? (
            <iframe
              src={`https://www.youtube-nocookie.com/embed/${e.videoId}?autoplay=1`}
              title={e.title ?? "YouTube"}
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              allowFullScreen
              className="h-full w-full"
            />
          ) : (
            <button onClick={() => setPlaying(true)} className="group relative h-full w-full">
              {e.thumbnail && <img src={mediaUrl(e.thumbnail.url)} alt="" className="h-full w-full object-cover" />}
              <span className="absolute left-1/2 top-1/2 flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-canvas/80 text-white transition-transform group-hover:scale-110">
                <Play size={24} className="ml-1" />
              </span>
            </button>
          )}
        </div>
      )}
      {e.image && e.type === "link" && (
        <img src={mediaUrl(e.image.url)} alt="" loading="lazy" className="max-h-[300px] w-full rounded-lg object-cover" />
      )}
    </div>
  );
}

// ── reactions ───────────────────────────────────────────────────────────────
export function ReactionEmoji({ emoji, size = 18 }: { emoji: string; size?: number }) {
  const parsed = parseReactionKey(emoji);
  const url = useData((s) => {
    if (!parsed.id) return null;
    for (const list of Object.values(s.emojis)) {
      const e = list.find((x) => x.id === parsed.id);
      if (e) return e.url;
    }
    return null;
  });
  if (parsed.id) return url ? <img src={mediaUrl(url, 48)} alt={`:${parsed.name}:`} style={{ width: size, height: size }} className="object-contain" /> : <span className="text-[12px]">:{parsed.name}:</span>;
  return <span style={{ fontSize: size, lineHeight: 1 }}>{emoji}</span>;
}

function burst(el: HTMLElement, emoji: string) {
  if (document.documentElement.classList.contains("fx-off")) return;
  const r = el.getBoundingClientRect();
  for (let i = 0; i < 8; i++) {
    const p = document.createElement("span");
    const angle = (Math.PI * 2 * i) / 8 + Math.random() * 0.4;
    const dist = 26 + Math.random() * 22;
    p.textContent = parseReactionKey(emoji).id ? "✦" : emoji;
    p.style.cssText = `position:fixed;left:${r.left + r.width / 2}px;top:${r.top + r.height / 2}px;font-size:${10 + Math.random() * 6}px;pointer-events:none;z-index:90;--dx:${Math.cos(angle) * dist}px;--dy:${Math.sin(angle) * dist}px;animation:burst .7s cubic-bezier(.2,.8,.3,1) forwards;color:rgb(var(--star))`;
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 750);
  }
}

export function toggleReaction(m: MessageDTO, emoji: string, mine: boolean) {
  const path = `/api/channels/${m.channelId}/messages/${m.id}/reactions/${encodeURIComponent(emoji)}/@me`;
  void api(path, { method: mine ? "DELETE" : "PUT" }).catch((e) => toast(errorText(e), "error"));
}

export const Reactions = memo(function Reactions({ m, me }: { m: MessageDTO; me: string }) {
  const pop = usePopover();
  if (!m.reactions.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      {m.reactions.map((r) => (
        <ReactionPill key={r.emoji} r={r} m={m} me={me} />
      ))}
      <button onClick={pop.toggle} className="flex h-7 items-center rounded-lg px-1.5 text-fg-3 opacity-0 transition-opacity hover:bg-raised hover:text-fg group-hover/msg:opacity-100 touch-visible" aria-label={t("chat.menu.react")}>
        <SmilePlus size={17} />
      </button>
      <Popover anchor={pop.anchor} onClose={pop.close} placement="top-start">
        <EmojiPicker onClose={pop.close} onPick={(e) => toggleReaction(m, e.key, !!m.reactions.find((r) => r.emoji === e.key)?.users.includes(me))} />
      </Popover>
    </div>
  );
});

function ReactionPill({ r, m, me }: { r: ReactionDTO; m: MessageDTO; me: string }) {
  const mine = r.users.includes(me);
  const names = useData(useShallow((s) => r.users.slice(0, 6).map((u) => displayName(s, u, m.guildId))));
  const tip = t("chat.reactionTip", { names: names.join(", ") + (r.count > names.length ? " " + t("chat.moreReactions", { n: r.count - names.length }) : ""), emoji: parseReactionKey(r.emoji).id ? `:${parseReactionKey(r.emoji).name}:` : r.emoji });
  return (
    <Tooltip content={tip}>
      <button
        onClick={(e) => {
          if (!mine) burst(e.currentTarget, r.emoji);
          toggleReaction(m, r.emoji, mine);
        }}
        className={clsx("flex h-7 items-center gap-1.5 rounded-lg px-2 text-[13px] font-semibold tabular-nums transition-all duration-150 active:scale-95", mine ? "bg-star/18 text-star ring-1 ring-star/60" : "bg-raised/80 text-fg-2 ring-1 ring-transparent hover:ring-line/25")}
      >
        <ReactionEmoji emoji={r.emoji} />
        <span key={r.count} className="anim-pop">
          {r.count}
        </span>
      </button>
    </Tooltip>
  );
}

// ── poll ────────────────────────────────────────────────────────────────────
export const Poll = memo(function Poll({ m, me }: { m: MessageDTO; me: string }) {
  const poll = m.poll as PollDTO;
  const mineAnswers = poll.answers.filter((a) => a.voters.includes(me)).map((a) => a.id);
  const [pending, setPending] = useState<string[]>(mineAnswers);
  const [showResults, setShowResults] = useState(false);
  const total = new Set(poll.answers.flatMap((a) => a.voters)).size;
  const voted = mineAnswers.length > 0;
  const results = poll.finalized || voted || showResults;
  const max = Math.max(...poll.answers.map((a) => a.votes), 0);
  const vote = (ids: string[]) => void api(`/api/channels/${m.channelId}/polls/${m.id}/votes`, { method: "POST", body: { answers: ids } }).catch((e) => toast(errorText(e), "error"));
  const left = poll.expiresAt ? Math.max(0, new Date(poll.expiresAt).getTime() - Date.now()) : null;
  const leftText = left === null ? null : left > 86_400_000 ? t("poll.days", { n: Math.ceil(left / 86_400_000) }) : left > 3_600_000 ? t("poll.hours", { n: Math.ceil(left / 3_600_000) }) : t("time.minutes", { n: Math.ceil(left / 60_000) });

  return (
    <div className="mt-1 w-full max-w-[440px] rounded-2xl bg-raised/70 p-4 hairline">
      <div className="text-[16px] font-semibold leading-snug">{poll.question}</div>
      <div className="mb-3 mt-0.5 text-[12.5px] text-fg-3">{poll.allowMultiselect ? t("poll.pickMany") : t("poll.pickOne")}</div>
      <div className="flex flex-col gap-2">
        {poll.answers.map((a) => {
          const pct = total ? Math.round((a.votes / total) * 100) : 0;
          const mine = mineAnswers.includes(a.id);
          const selected = pending.includes(a.id);
          const winner = poll.finalized && a.votes === max && max > 0;
          return (
            <button
              key={a.id}
              disabled={poll.finalized}
              onClick={() => {
                if (poll.allowMultiselect) setPending(selected ? pending.filter((x) => x !== a.id) : [...pending, a.id]);
                else vote(mine ? [] : [a.id]);
              }}
              className={clsx(
                "relative flex min-h-11 items-center gap-3 overflow-hidden rounded-xl px-3 text-left text-[14.5px] ring-1 transition-colors",
                mine || selected ? "ring-star/70" : "ring-line/15 hover:ring-line/35",
                poll.finalized && "cursor-default"
              )}
            >
              {results && <span className={clsx("absolute inset-y-0 left-0 transition-[width] duration-500", winner ? "bg-star/30" : "bg-star/12")} style={{ width: `${pct}%` }} />}
              <span className="relative flex min-w-0 flex-1 items-center gap-2">
                {a.emoji && <span>{a.emoji}</span>}
                <span className="truncate font-medium">{a.text}</span>
                {mine && <Check size={15} className="shrink-0 text-star" />}
              </span>
              {results && <span className="relative shrink-0 text-[13px] font-semibold tabular-nums text-fg-2">{pct}%</span>}
            </button>
          );
        })}
      </div>
      <div className="mt-3 flex items-center gap-2 text-[12.5px] text-fg-3">
        <span>{t("poll.votes", { n: total })}</span>
        {leftText && !poll.finalized && <span>· {t("poll.endsIn", { t: leftText })}</span>}
        {poll.finalized && <span>· {t("poll.ended")}</span>}
        <span className="flex-1" />
        {!poll.finalized && !voted && (
          <button onClick={() => setShowResults(!showResults)} className="font-semibold text-sky hover:underline">
            {showResults ? t("poll.backToVote") : t("poll.showResults")}
          </button>
        )}
        {poll.allowMultiselect && !poll.finalized && (
          <button onClick={() => vote(pending)} className="star-fill rounded-lg px-3 py-1 text-[13px] font-semibold">
            {t("poll.vote")}
          </button>
        )}
        {!poll.finalized && m.author.id === me && (
          <button onClick={() => void api(`/api/channels/${m.channelId}/polls/${m.id}/end`, { method: "POST" })} className="font-semibold text-fg-2 hover:text-fg">
            {t("poll.endNow")}
          </button>
        )}
      </div>
    </div>
  );
});

// ── thread chip ─────────────────────────────────────────────────────────────
export function ThreadChip({ m }: { m: MessageDTO }) {
  if (!m.thread) return null;
  return (
    <button
      onClick={() => useUI.setState({ threadId: m.thread!.id, panel: "thread" })}
      className="mt-1.5 flex max-w-[420px] items-center gap-2 rounded-xl bg-raised/70 px-3 py-2 text-left hairline transition-colors hover:bg-raised"
    >
      <MessagesSquare size={16} className="shrink-0 text-star" />
      <span className="truncate text-[14px] font-semibold">{m.thread.name}</span>
      <span className="shrink-0 text-[13px] text-sky">{t("chat.threadReplies", { n: m.thread.messageCount })}</span>
    </button>
  );
}
