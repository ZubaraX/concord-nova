// FM radio: its own button in the call. The station on (live), your FM volume,
// and the catalogue — popular stations of Russia, or a search of any country.
import { useEffect, useState } from "react";
import clsx from "clsx";
import { Loader2, Radio, Search } from "lucide-react";
import { t } from "../../lib/i18n";
import { mediaUrl } from "../../lib/server";
import { useDebounced } from "../../lib/hooks";
import { displayName, useData } from "../../store/data";
import { settings, useSettings } from "../../store/settings";
import { Popover, Tooltip, usePopover } from "../../components/ui/overlay";
import { Slider } from "../../components/ui/primitives";
import { useVoice } from "./voice";
import { useRadio } from "./radio";
import { popularStations, searchStations, turnOff, turnOn, type FmStation } from "./fm";

export function FmButton({ className }: { className?: string }) {
  const pop = usePopover();
  const channelId = useVoice((s) => s.channelId);
  const on = useRadio((s) => !!(channelId && s.states[channelId]?.station));
  return (
    <>
      <Tooltip content={t("fm.title")}>
        <button type="button" onClick={pop.toggle} className={clsx(className, (pop.anchor || on) && "!bg-star/20 !text-star")} aria-label={t("fm.title")} aria-expanded={!!pop.anchor}>
          <Radio size={21} />
        </button>
      </Tooltip>
      <Popover anchor={pop.anchor} onClose={pop.close} placement="top">
        {channelId && <FmPanel channelId={channelId} />}
      </Popover>
    </>
  );
}

function FmPanel({ channelId }: { channelId: string }) {
  const station = useRadio((s) => s.states[channelId]?.station ?? null);
  const by = useData((s) => (station ? displayName(s, station.startedBy, null) : ""));
  const volume = useSettings((s) => s.fmVolume ?? 60);
  const [q, setQ] = useState("");
  const query = useDebounced(q.trim(), 350);
  const [list, setList] = useState<FmStation[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setList(null);
    setFailed(false);
    (query.length >= 2 ? searchStations(query) : popularStations()).then(
      (l) => alive && setList(l),
      () => alive && setFailed(true)
    );
    return () => {
      alive = false;
    };
  }, [query]);

  return (
    <div data-fm className="menu-surface scroll-thin flex max-h-[calc(100vh-var(--chrome-top,0px)-120px)] w-[min(372px,calc(100vw-16px))] flex-col gap-3 overflow-y-auto rounded-2xl p-3 shadow-lift">
      <div className="font-display text-[15px] font-semibold">{t("fm.title")}</div>
      {station && (
        <div data-fm-now className="flex items-center gap-3 rounded-xl bg-canvas/60 p-3 ring-1 ring-line/10">
          {station.favicon ? <img src={mediaUrl(station.favicon)} alt="" className="h-10 w-10 shrink-0 rounded-lg bg-canvas object-cover" /> : <Radio size={28} className="shrink-0 text-star" />}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-bad">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-bad" /> {t("fm.live")}
            </div>
            <div className="truncate text-[14px] font-semibold">{station.name}</div>
            <div className="truncate text-[12px] text-fg-3">{t("fm.on", { name: by })}</div>
          </div>
          <button onClick={() => void turnOff(channelId)} className="shrink-0 rounded-lg bg-raised px-3 py-1.5 text-[13px] font-semibold hover:bg-overlay">
            {t("fm.off")}
          </button>
        </div>
      )}
      <div className="flex items-center gap-2.5">
        <span className="w-[110px] shrink-0 text-[12px] font-semibold text-fg-3">{t("fm.volume")}</span>
        <Slider value={volume} onChange={(v) => settings().setLocal({ fmVolume: v })} format={(v) => `${v}%`} className="min-w-0 flex-1" />
      </div>
      <div className="relative">
        <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-3" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("fm.search")} className="h-9 w-full rounded-lg bg-canvas/70 pl-9 pr-3 text-[13px] outline-none ring-1 ring-line/10 focus:ring-star/60" />
      </div>
      <div className="text-[11.5px] font-semibold text-fg-3">{query.length >= 2 ? t("fm.found") : t("fm.popular")}</div>
      <div className="flex flex-col">
        {failed && <p className="py-3 text-center text-[13px] text-fg-3">{t("fm.unavailable")}</p>}
        {!list && !failed && <Loader2 size={18} className="mx-auto my-3 anim-spin text-fg-3" />}
        {list && !list.length && <p className="py-3 text-center text-[13px] text-fg-3">{t("fm.nothingFound")}</p>}
        {list?.map((s) => (
          <button
            key={s.id}
            onClick={() => void turnOn(channelId, s)}
            className={clsx("flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-raised", station?.url === s.url && "bg-star/10")}
          >
            <Radio size={16} className="shrink-0 text-fg-3" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">{s.name}</span>
              <span className="block truncate text-[11.5px] text-fg-3">{[s.country, s.codec, s.bitrate ? `${s.bitrate} kbps` : "", s.tags.split(",").slice(0, 2).join(", ")].filter(Boolean).join(" · ")}</span>
            </span>
          </button>
        ))}
      </div>
      <p className="text-[11.5px] leading-snug text-fg-3">{t("fm.hint")}</p>
    </div>
  );
}
