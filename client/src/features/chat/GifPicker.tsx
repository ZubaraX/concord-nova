// The GIF tab of the composer's picker: favourites and recently sent GIFs
// (always there), plus search and trending when the server has a KLIPY key.
import { useEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { Clock, Flame, Loader2, Search, Star, X } from "lucide-react";
import { UserFlags, type GifConfigDTO, type GifDTO } from "@nova/shared";
import { t } from "../../lib/i18n";
import { mediaUrl } from "../../lib/server";
import { useDebounced } from "../../lib/hooks";
import { isTouch } from "../../lib/platform";
import { GifError, gifCategories, gifConfig, isFavorite, loadFavorites, searchGifs, toggleFavorite, useGifs, type GifCategory, type GifFailure, type GifRef } from "../../lib/gifs";
import { useData } from "../../store/data";
import { useUI } from "../../store/ui";

type Shelf = "favorites" | "recent" | "trending";

/** Star on a GIF — in the picker and on GIFs in chat. */
export function FavoriteStar({ gif, className }: { gif: GifRef; className?: string }) {
  const on = useGifs((s) => isFavorite(s, gif.url));
  // A server older than 1.2 has nowhere to keep favourites.
  const supported = useGifs((s) => s.supported);
  if (!supported) return null;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void toggleFavorite(gif);
      }}
      aria-label={on ? t("gif.unfavorite") : t("gif.favorite")}
      aria-pressed={on}
      title={on ? t("gif.unfavorite") : t("gif.favorite")}
      className={clsx(
        "absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-lg bg-canvas/75 backdrop-blur transition-[opacity,transform,color] hover:scale-110 focus-visible:opacity-100",
        on ? "text-warn opacity-100" : "text-white opacity-0 group-hover/gif:opacity-100 touch-visible",
        className
      )}
    >
      <Star size={15} fill={on ? "currentColor" : "none"} />
    </button>
  );
}

/** Search results or trending, a page at a time. */
function useRemote(key: string | null, enabled: boolean, query: string) {
  const [state, setState] = useState<{ items: GifDTO[] | null; more: boolean; error: GifFailure | null }>({ items: null, more: false, error: null });
  const [attempt, setAttempt] = useState(0);
  const page = useRef(1);
  const busy = useRef(false);
  const run = useRef(0);

  useEffect(() => {
    if (!key || !enabled) return;
    const mine = ++run.current;
    const ctl = new AbortController();
    page.current = 1;
    busy.current = true;
    setState({ items: null, more: false, error: null });
    searchGifs(key, query, 1, ctl.signal).then(
      (p) => {
        if (run.current !== mine) return;
        busy.current = false;
        setState({ items: p.items, more: p.more, error: null });
      },
      (e) => {
        if (run.current !== mine) return;
        busy.current = false;
        setState({ items: [], more: false, error: e instanceof GifError ? e.reason : "network" });
      }
    );
    return () => ctl.abort();
  }, [key, enabled, query, attempt]);

  const loadMore = () => {
    if (!key || busy.current || !state.more) return;
    const mine = run.current;
    const next = page.current + 1;
    busy.current = true;
    searchGifs(key, query, next).then(
      (p) => {
        if (run.current !== mine) return;
        busy.current = false;
        page.current = next;
        setState((s) => ({ items: [...(s.items ?? []), ...p.items], more: p.more, error: null }));
      },
      () => {
        if (run.current !== mine) return;
        busy.current = false;
        setState((s) => ({ ...s, more: false }));
      }
    );
  };
  return { ...state, loadMore, retry: () => setAttempt((a) => a + 1) };
}

function Chip({ active, icon, children, onClick }: { active: boolean; icon?: ReactNode; children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        "flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[12.5px] font-semibold transition-colors",
        active ? "bg-star/20 text-star" : "bg-raised text-fg-2 hover:text-fg"
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-[14px] leading-snug text-fg-3">{children}</div>;
}

function Tile({ gif, onPick }: { gif: GifDTO; onPick: (g: GifDTO) => void }) {
  const [broken, setBroken] = useState(false);
  // A favourite whose file is gone: nothing to send.
  if (broken) return null;
  return (
    <div data-gif={gif.url} className="group/gif relative overflow-hidden rounded-lg bg-raised" style={{ aspectRatio: gif.width && gif.height ? `${gif.width}/${gif.height}` : "1" }}>
      <button type="button" onClick={() => onPick(gif)} className="block h-full w-full transition-transform duration-200 hover:scale-[1.03]" aria-label={t("gif.send")}>
        <img src={mediaUrl(gif.preview || gif.url)} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setBroken(true)} className="h-full w-full object-cover" />
      </button>
      <FavoriteStar gif={gif} />
    </div>
  );
}

function Grid({ items, onPick }: { items: GifDTO[]; onPick: (g: GifDTO) => void }) {
  // Two columns, each new GIF under the shorter one — the order still reads top to bottom.
  const cols: GifDTO[][] = [[], []];
  const heights = [0, 0];
  for (const g of items) {
    const i = heights[0] <= heights[1] ? 0 : 1;
    cols[i].push(g);
    heights[i] += g.width && g.height ? g.height / g.width : 1;
  }
  return (
    <div className="flex gap-2" data-testid="gif-grid">
      {cols.map((col, ci) => (
        <div key={ci} className="flex min-w-0 flex-1 flex-col gap-2">
          {col.map((g, i) => (
            <Tile key={`${g.url}#${i}`} gif={g} onPick={onPick} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function GifTab({ onPick, onClose }: { onPick: (g: GifDTO, query: string) => void; onClose?: () => void }) {
  const [cfg, setCfg] = useState<GifConfigDTO | null>(null);
  const [cats, setCats] = useState<GifCategory[]>([]);
  const [shelf, setShelf] = useState<Shelf | null>(null);
  const [q, setQ] = useState("");
  const query = useDebounced(q.trim(), 400);
  const favorites = useGifs((s) => s.favorites);
  const recent = useGifs((s) => s.recent);
  const favLoaded = useGifs((s) => s.loaded);
  const supported = useGifs((s) => s.supported);
  const admin = useData((s) => !!s.me && (s.me.flags & UserFlags.INSTANCE_ADMIN) !== 0);

  useEffect(() => {
    let alive = true;
    void loadFavorites();
    gifConfig().then(
      (c) => alive && setCfg(c),
      () => alive && setCfg({ provider: null, key: null })
    );
    return () => {
      alive = false;
    };
  }, []);

  const key = cfg?.key ?? null;
  useEffect(() => {
    if (!key) return;
    let alive = true;
    gifCategories(key).then(
      (list) => alive && setCats(list),
      () => {}
    );
    return () => {
      alive = false;
    };
  }, [key]);

  // With search on, the front page is what's trending; without it — your own GIFs.
  const active: Shelf = shelf ?? (key ? "trending" : "favorites");
  const searching = !!key && !!query;
  const remote = useRemote(key, searching || active === "trending", searching ? query : "");
  const pick = (g: GifDTO) => onPick(g, searching ? query : "");
  const open = (s: Shelf) => {
    setShelf(s);
    setQ("");
  };

  let body: ReactNode;
  if (!cfg) {
    body = (
      <Note>
        <Loader2 className="anim-spin" />
      </Note>
    );
  } else if (searching || active === "trending") {
    if (remote.error) {
      body = (
        <Note>
          {t(`gif.error.${remote.error}`)}
          <button type="button" onClick={remote.retry} className="font-semibold text-sky hover:underline">
            {t("gif.retry")}
          </button>
        </Note>
      );
    } else if (!remote.items) {
      body = (
        <Note>
          <Loader2 className="anim-spin" />
        </Note>
      );
    } else if (!remote.items.length) body = <Note>{t("gif.none")}</Note>;
    else body = <Grid items={remote.items} onPick={pick} />;
  } else if (active === "favorites") {
    if (!supported) body = <Note>{t("gif.serverOld")}</Note>;
    else if (favLoaded === null) {
      body = (
        <Note>
          <Loader2 className="anim-spin" />
        </Note>
      );
    } else if (!favorites.length) {
      body = (
        <Note>
          <Star size={26} className="text-fg-3" />
          {t("gif.noFavorites")}
        </Note>
      );
    } else body = <Grid items={favorites} onPick={pick} />;
  } else {
    body = recent.length ? <Grid items={recent} onPick={pick} /> : <Note>{t("gif.noRecent")}</Note>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="gif-tab">
      {key && (
        <div className="px-3 pt-3">
          <div className="relative">
            <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-3" />
            <input
              // Phones: don't cover half the picker with the keyboard before anything is typed.
              autoFocus={!isTouch}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              maxLength={100}
              placeholder={t("gif.search")}
              className="h-9 w-full rounded-lg bg-canvas/70 pl-8 pr-8 text-[14px] outline-none ring-1 ring-line/10 focus:ring-star/60"
            />
            {q && (
              <button type="button" onClick={() => setQ("")} aria-label={t("gif.clear")} className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-fg-3 hover:text-fg">
                <X size={14} />
              </button>
            )}
          </div>
        </div>
      )}
      <div
        className="flex shrink-0 gap-1.5 overflow-x-auto px-3 py-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        // A mouse wheel scrolls the row sideways.
        onWheel={(e) => {
          if (!e.shiftKey && e.deltaY) e.currentTarget.scrollLeft += e.deltaY;
        }}
      >
        <Chip active={!searching && active === "favorites"} icon={<Star size={13} />} onClick={() => open("favorites")}>
          {t("gif.favorites")}
        </Chip>
        <Chip active={!searching && active === "recent"} icon={<Clock size={13} />} onClick={() => open("recent")}>
          {t("gif.recent")}
        </Chip>
        {key && (
          <Chip active={!searching && active === "trending"} icon={<Flame size={13} />} onClick={() => open("trending")}>
            {t("gif.trending")}
          </Chip>
        )}
        {key &&
          cats.map((c) => (
            <Chip key={c.query} active={searching && query.toLowerCase() === c.query.toLowerCase()} onClick={() => setQ(c.query)}>
              {c.label}
            </Chip>
          ))}
      </div>
      <div
        className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 pb-3"
        onScroll={(e) => {
          const el = e.currentTarget;
          if ((searching || active === "trending") && el.scrollTop + el.clientHeight > el.scrollHeight - 240) remote.loadMore();
        }}
      >
        {body}
      </div>
      {cfg && !key && supported && (
        <div className="flex shrink-0 items-center gap-2 border-t border-line/10 px-3 py-2 text-[12.5px] leading-snug text-fg-3">
          <span className="min-w-0 flex-1">{admin ? t("gif.searchOffAdmin") : t("gif.searchOff")}</span>
          {admin && (
            <button
              type="button"
              onClick={() => {
                onClose?.();
                useUI.getState().setModal({ kind: "userSettings", tab: "admin-overview" });
              }}
              className="shrink-0 rounded-lg bg-raised px-2.5 py-1 font-semibold text-fg hover:bg-overlay"
            >
              {t("gif.setup")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
