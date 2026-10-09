// The call's radio: what plays, your own volume, the queue, adding files or a
// link, and the Yandex/VK links people shared (tiles).
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { useShallow } from "zustand/react/shallow";
import { ExternalLink, FolderOpen, ListMusic, Music, Pause, Play, Plus, SkipForward, Upload, X } from "lucide-react";
import type { RadioLinkDTO } from "@nova/shared";
import { t } from "../../lib/i18n";
import { isDesktop } from "../../lib/platform";
import { mediaUrl } from "../../lib/server";
import { displayName, useData } from "../../store/data";
import { settings, useSettings } from "../../store/settings";
import { Popover, Tooltip, usePopover } from "../../components/ui/overlay";
import { Slider } from "../../components/ui/primitives";
import { useVoice } from "./voice";
import { addFiles, addFolder, addLink, myFile, pause, removeItem, resume, serverNow, skip, useRadio } from "./radio";
import { linkKind, yandexEmbed } from "./musicLinks";
import { useRadioFiles } from "./radioFiles";

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function RadioButton({ className }: { className?: string }) {
  const pop = usePopover();
  const channelId = useVoice((s) => s.channelId);
  const playing = useRadio((s) => !!(channelId && s.states[channelId]?.current));
  return (
    <>
      <Tooltip content={t("radio.title")}>
        <button type="button" onClick={pop.toggle} className={clsx(className, (pop.anchor || playing) && "!bg-star/20 !text-star")} aria-label={t("radio.title")} aria-expanded={!!pop.anchor}>
          <ListMusic size={21} />
        </button>
      </Tooltip>
      <Popover anchor={pop.anchor} onClose={pop.close} placement="top">
        {channelId && <RadioPanel channelId={channelId} />}
      </Popover>
    </>
  );
}

export function RadioPanel({ channelId }: { channelId: string }) {
  const st = useRadio((s) => s.states[channelId]);
  const ready = useRadioFiles((s) => s.ready);
  const volume = useSettings((s) => s.radioVolume ?? 60);
  const [link, setLink] = useState("");
  const [drop, setDrop] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const cur = st?.current;
  const now = cur ? st!.items[0] : undefined;
  const pos = cur ? Math.min(now!.duration, (cur.pausedAt ?? serverNow() - cur.startedAt) / 1000) : 0;
  // A new list each time: compared by its names, or every read looks like a change (and React loops).
  const names = useData(useShallow((s) => (st?.items ?? []).map((i) => displayName(s, i.addedBy, null))));
  const waiting = now && now.kind === "file" && !myFile(now.id) && !ready[now.id];
  const links = (st?.links ?? []).slice().reverse();
  const linkNames = useData(useShallow((s) => links.map((l) => displayName(s, l.addedBy, null))));
  // The Yandex player opened from a tile (one at a time).
  const [openId, setOpenId] = useState<string | null>(null);
  const opened = links.find((l) => l.id === openId);
  const player = opened ? yandexEmbed(opened.url) : null;

  return (
    <div
      data-radio
      className={clsx(
        "menu-surface scroll-thin flex max-h-[calc(100vh-var(--chrome-top,0px)-120px)] w-[min(372px,calc(100vw-16px))] flex-col gap-3 overflow-y-auto rounded-2xl p-3 shadow-lift",
        drop && "ring-2 ring-star/60"
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setDrop(true);
      }}
      onDragLeave={() => setDrop(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrop(false);
        void addFiles(channelId, [...e.dataTransfer.files]);
      }}
    >
      <div className="font-display text-[15px] font-semibold">{t("radio.title")}</div>
      {now ? (
        <div className="rounded-xl bg-canvas/60 p-3 ring-1 ring-line/10">
          <div className="text-[11.5px] font-semibold text-fg-3">{t("radio.nowPlaying")}</div>
          <div className="truncate text-[14px] font-semibold">{now.title}</div>
          <div className="truncate text-[12px] text-fg-3">
            {t("radio.addedBy", { name: names[0] })} {waiting && `· ${t("radio.receiving")}`}
          </div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-line/15">
            <div className="h-full bg-star" style={{ width: `${(pos / now.duration) * 100}%` }} />
          </div>
          <div className="mt-1 flex items-center justify-between text-[11.5px] tabular-nums text-fg-3">
            <span>{fmt(pos)}</span>
            <div className="flex gap-1">
              {cur!.pausedAt !== null ? (
                <button onClick={() => void resume(channelId)} className="rounded-lg p-1.5 text-fg-2 hover:bg-raised hover:text-fg" aria-label={t("radio.play")}>
                  <Play size={16} />
                </button>
              ) : (
                <button onClick={() => void pause(channelId)} className="rounded-lg p-1.5 text-fg-2 hover:bg-raised hover:text-fg" aria-label={t("radio.pause")}>
                  <Pause size={16} />
                </button>
              )}
              <button onClick={() => skip(channelId)} className="rounded-lg p-1.5 text-fg-2 hover:bg-raised hover:text-fg" aria-label={t("radio.skip")}>
                <SkipForward size={16} />
              </button>
            </div>
            <span>{fmt(now.duration)}</span>
          </div>
        </div>
      ) : (
        <p className="text-[13px] text-fg-3">{t("radio.nothing")}</p>
      )}

      <div className="flex items-center gap-2.5">
        <span className="w-[110px] shrink-0 text-[12px] font-semibold text-fg-3">{t("radio.volume")}</span>
        <Slider value={volume} onChange={(v) => settings().setLocal({ radioVolume: v })} format={(v) => `${v}%`} className="min-w-0 flex-1" />
      </div>

      {st && st.items.length > 0 && (
        <div className="flex flex-col">
          <div className="mb-1 text-[11.5px] font-semibold text-fg-3">{t("radio.queue")}</div>
          {st.items.map((i, k) => (
            <div key={i.id} data-radio-item data-current={k === 0 && cur ? "" : undefined} className={clsx("group flex items-center gap-2 rounded-lg px-2 py-1.5", k === 0 && cur && "bg-star/10")}>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{i.title}</div>
                <div className="truncate text-[11.5px] text-fg-3">
                  {names[k]} · {fmt(i.duration)}
                </div>
              </div>
              <button onClick={() => void removeItem(channelId, i.id)} className="rounded p-1 text-fg-3 opacity-0 hover:text-bad group-hover:opacity-100 touch-visible" aria-label={t("radio.remove")}>
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      <input ref={file} type="file" accept="audio/*,.m3u,.m3u8,.pls" multiple hidden onChange={(e) => (void addFiles(channelId, [...(e.target.files ?? [])]), (e.target.value = ""))} />
      {/* A folder of music: everything audio in it, in name order. */}
      <input ref={folder} type="file" multiple hidden {...{ webkitdirectory: "" }} onChange={(e) => (void addFolder(channelId, [...(e.target.files ?? [])]), (e.target.value = ""))} />
      <div className="flex gap-2">
        <button onClick={() => file.current?.click()} className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-raised py-2 text-[13.5px] font-semibold hover:bg-overlay">
          <Upload size={16} /> {t("radio.addFiles")}
        </button>
        <button onClick={() => folder.current?.click()} className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-raised py-2 text-[13.5px] font-semibold hover:bg-overlay">
          <FolderOpen size={16} /> {t("radio.addFolder")}
        </button>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!link.trim()) return;
          const sent = link;
          // Cleared only if it still holds what was sent (the next link may be typed already).
          void addLink(channelId, sent).then(() => setLink((v) => (v === sent ? "" : v)));
        }}
      >
        <input value={link} onChange={(e) => setLink(e.target.value)} placeholder={t("radio.linkPlaceholder")} className="h-9 min-w-0 flex-1 rounded-lg bg-canvas/70 px-3 text-[13px] outline-none ring-1 ring-line/10 focus:ring-star/60" />
        <button type="submit" className="flex items-center gap-1 rounded-lg bg-star px-3 text-[13px] font-semibold text-on-star">
          <Plus size={14} /> {t("radio.addLink")}
        </button>
      </form>

      {links.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="text-[11.5px] font-semibold text-fg-3">{t("radio.shared")}</div>
          {/* Yandex: its own player, which each person plays on their device with their own account. */}
          {opened && player && (
            <div className="flex flex-col gap-1">
              <div className="relative">
                <iframe
                  src={player.src}
                  title={opened.title ?? opened.url}
                  allow="clipboard-write; autoplay; encrypted-media"
                  className="w-full rounded-lg border-0 bg-canvas"
                  style={{ height: player.height }}
                />
                <button onClick={() => setOpenId(null)} className="absolute -right-1.5 -top-1.5 grid h-6 w-6 place-items-center rounded-full bg-raised text-fg-2 shadow ring-1 ring-line/15 hover:text-fg" aria-label={t("radio.closePlayer")}>
                  <X size={13} />
                </button>
              </div>
              <span className="text-[11px] leading-snug text-fg-3">{t("radio.yandexHint")}</span>
              <span className="text-[11px] leading-snug text-warn">{t("radio.playerVolume")}</span>
            </div>
          )}
          <div className="grid grid-cols-3 gap-2">
            {links.map((l, k) => (
              <LinkTile
                key={l.id}
                link={l}
                by={linkNames[k]}
                active={l.id === openId}
                onOpen={() => (yandexEmbed(l.url) ? setOpenId(l.id === openId ? null : l.id) : openOutside(l.url))}
              />
            ))}
          </div>
          <p className="text-[11px] leading-snug text-fg-3">{t("radio.sharedHint")}</p>
        </div>
      )}
      <p className="text-[11.5px] leading-snug text-fg-3">{t("radio.hint")}</p>
    </div>
  );
}

/** A shared Yandex Music / VK link: its cover, title and who shared it. */
function LinkTile({ link, by, active, onOpen }: { link: RadioLinkDTO; by: string; active: boolean; onOpen: () => void }) {
  const kind = t(`radio.kind.${linkKind(link.url)}`);
  const here = !!yandexEmbed(link.url);
  return (
    <button
      data-radio-link
      data-service={link.service}
      onClick={onOpen}
      title={here ? link.title ?? kind : t(`radio.openIn.${link.service}`)}
      className={clsx("flex min-w-0 flex-col overflow-hidden rounded-xl bg-canvas/60 text-left ring-1 ring-line/10 transition hover:ring-star/50", active && "!ring-2 !ring-star")}
    >
      <span className={clsx("relative block aspect-square w-full", link.service === "yandex" ? "bg-gradient-to-br from-[#ffd84d] to-[#ff8f1f]" : "bg-gradient-to-br from-[#2787f5] to-[#0057d9]")}>
        {link.image ? <img src={mediaUrl(link.image)} alt="" loading="lazy" className="h-full w-full object-cover" /> : <Music size={28} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-white/90" />}
        <span className="absolute left-1 top-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-bold text-white">{t(`radio.service.${link.service}`)}</span>
        <span className="absolute bottom-1 right-1 grid h-7 w-7 place-items-center rounded-full bg-star text-on-star shadow">{here ? <Play size={13} /> : <ExternalLink size={13} />}</span>
      </span>
      <span className="block px-1.5 py-1">
        <span className="block truncate text-[12px] font-semibold">{link.title ?? kind}</span>
        <span className="block truncate text-[10.5px] text-fg-3">{by}</span>
      </span>
    </button>
  );
}

/** VK (it can't be embedded) and Yandex links without a player: their site or app. */
function openOutside(url: string) {
  if (isDesktop) window.nova!.openExternal(url);
  else window.open(url, "_blank", "noopener");
}

/** "🎵 title" under a voice channel where the radio plays. */
export function RadioLine({ channelId }: { channelId: string }) {
  const line = useRadio((s) => {
    const st = s.states[channelId];
    if (st?.station) return `📻 ${st.station.name}`;
    return st?.current ? `🎵 ${st.items[0]?.title ?? ""}` : undefined;
  });
  if (!line) return null;
  return (
    <div data-radio-now className="ml-6 truncate text-[12px] text-fg-3">
      {line}
    </div>
  );
}
