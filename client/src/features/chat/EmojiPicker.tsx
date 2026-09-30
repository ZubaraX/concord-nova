import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Clock, Smile, User, Leaf, Coffee, Plane, Trophy, Lamp, Heart, Flag, Search, Loader2 } from "lucide-react";
import type { EmojiDTO, GifDTO } from "@nova/shared";
import { loadEmoji, recordRecent, searchEmoji, withSkin, type Emoji } from "../../lib/emoji";
import { t, tr } from "../../lib/i18n";
import { mediaUrl } from "../../lib/server";
import { useData } from "../../store/data";
import { settings, useSettings } from "../../store/settings";
import { GuildIcon } from "../../components/ui/avatar";
import { GifTab } from "./GifPicker";

export interface PickedEmoji {
  /** Reaction key: unicode char, or "name:id" for custom emoji. */
  key: string;
  /** Text to insert into the composer. */
  text: string;
  custom?: EmojiDTO;
}

const GROUP_ICONS = [Smile, User, null, Leaf, Coffee, Plane, Trophy, Lamp, Heart, Flag];
const TONES = ["✋", "✋🏻", "✋🏼", "✋🏽", "✋🏾", "✋🏿"];

export function EmojiPicker({
  onPick,
  closeOnPick = true,
  onClose,
  tabs = ["emoji"],
  initialTab,
  onGif,
}: {
  onPick: (e: PickedEmoji) => void;
  closeOnPick?: boolean;
  onClose?: () => void;
  tabs?: ("emoji" | "gif")[];
  /** Which tab to open on (the composer's GIF button opens straight on GIFs). */
  initialTab?: "emoji" | "gif";
  /** `query` is the search that found the GIF ("" for favourites, recent and trending). */
  onGif?: (g: GifDTO, query: string) => void;
}) {
  const [tab, setTab] = useState<"emoji" | "gif">(initialTab && tabs.includes(initialTab) ? initialTab : tabs[0]);
  return (
    <div className="menu-surface flex h-[440px] w-[min(380px,calc(100vw-16px))] flex-col overflow-hidden rounded-2xl shadow-lift">
      {tabs.length > 1 && (
        <div className="flex gap-1 px-3 pt-3">
          {tabs.map((x) => (
            <button key={x} onClick={() => setTab(x)} aria-pressed={tab === x} data-tab={x} className={clsx("rounded-lg px-3 py-1.5 text-[13.5px] font-semibold transition-colors", tab === x ? "bg-raised text-fg" : "text-fg-3 hover:text-fg")}>
              {x === "emoji" ? t("chat.emoji") : t("chat.gif")}
            </button>
          ))}
        </div>
      )}
      {tab === "emoji" ? (
        <EmojiTab
          onPick={(e) => {
            recordRecent(e.key);
            onPick(e);
            if (closeOnPick) onClose?.();
          }}
        />
      ) : (
        <GifTab
          onClose={onClose}
          onPick={(g, query) => {
            onGif?.(g, query);
            onClose?.();
          }}
        />
      )}
    </div>
  );
}

function EmojiTab({ onPick }: { onPick: (e: PickedEmoji) => void }) {
  const [all, setAll] = useState<Emoji[] | null>(null);
  const [q, setQ] = useState("");
  const [hover, setHover] = useState<{ char: string; label: string; img?: string } | null>(null);
  const [toneOpen, setToneOpen] = useState(false);
  const tone = useSettings((s) => s.skinTone);
  const recent = useSettings((s) => s.recentEmoji);
  const emojis = useData((s) => s.emojis);
  const guilds = useData((s) => s.guilds);
  const scroller = useRef<HTMLDivElement>(null);
  const groupNames = tr<string[]>("emoji.groups") ?? [];

  useEffect(() => {
    void loadEmoji().then(setAll);
  }, []);

  const customAll = useMemo(() => Object.values(emojis).flat(), [emojis]);
  const results = useMemo(() => {
    if (!q.trim() || !all) return null;
    const needle = q.trim().toLowerCase().replace(/^:/, "");
    const custom = customAll.filter((e) => e.name.toLowerCase().includes(needle)).slice(0, 30);
    return { custom, unicode: searchEmoji(q) };
  }, [q, all, customAll]);

  const groups = useMemo(() => {
    const m = new Map<number, Emoji[]>();
    for (const e of all ?? []) {
      let g = m.get(e.group);
      if (!g) m.set(e.group, (g = []));
      g.push(e);
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [all]);

  const pickUnicode = (e: Emoji) => {
    const ch = withSkin(e, tone);
    onPick({ key: ch, text: ch });
  };
  const pickCustom = (e: EmojiDTO) => onPick({ key: `${e.name}:${e.id}`, text: `:${e.name}:`, custom: e });

  const recentItems = recent
    .map((k) => {
      const m = /^(\w{2,32}):([0-9A-Z]{26})$/.exec(k);
      if (m) {
        const c = customAll.find((e) => e.id === m[2]);
        return c ? { custom: c } : null;
      }
      return { char: k };
    })
    .filter(Boolean) as ({ custom: EmojiDTO } | { char: string })[];

  const jump = (id: string) => scroller.current?.querySelector(`[data-section="${id}"]`)?.scrollIntoView({ block: "start" });

  const Cell = ({ children, onClick, label, img }: { children: React.ReactNode; onClick: () => void; label: string; img?: string }) => (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover({ char: typeof children === "string" ? children : "", label, img })}
      className="flex h-10 w-10 items-center justify-center rounded-lg text-[26px] leading-none transition-transform hover:scale-110 hover:bg-raised"
      aria-label={label}
    >
      {children}
    </button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 p-3">
        <div className="relative flex-1">
          <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-3" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("emoji.search")} className="h-9 w-full rounded-lg bg-canvas/70 pl-8 pr-2 text-[14px] outline-none ring-1 ring-line/10 focus:ring-star/60" />
        </div>
        <div className="relative">
          <button onClick={() => setToneOpen(!toneOpen)} className="flex h-9 w-9 items-center justify-center rounded-lg text-[20px] hover:bg-raised" aria-label={t("emoji.skinTone")}>
            {TONES[tone]}
          </button>
          {toneOpen && (
            <div className="absolute right-0 top-10 z-10 flex flex-col rounded-xl bg-canvas p-1 shadow-lift hairline">
              {TONES.map((x, i) => (
                <button
                  key={x}
                  onClick={() => {
                    settings().setLocal({ skinTone: i });
                    setToneOpen(false);
                  }}
                  className="rounded-lg p-1 text-[20px] hover:bg-raised"
                >
                  {x}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        {!results && (
          <div className="scroll-thin flex w-11 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-line/10 py-1">
            {recentItems.length > 0 && (
              <button onClick={() => jump("recent")} className="rounded-lg p-1.5 text-fg-3 hover:bg-raised hover:text-fg" aria-label={t("emoji.recent")}>
                <Clock size={18} />
              </button>
            )}
            {Object.entries(emojis)
              .filter(([, l]) => l.length)
              .map(([gid]) => (
                <button key={gid} onClick={() => jump(`g-${gid}`)} className="rounded-lg p-1 hover:bg-raised" aria-label={guilds[gid]?.name}>
                  <GuildIcon guildId={gid} name={guilds[gid]?.name ?? "?"} icon={guilds[gid]?.icon ?? null} size={24} />
                </button>
              ))}
            {groups.map(([g]) => {
              const Icon = GROUP_ICONS[g];
              return Icon ? (
                <button key={g} onClick={() => jump(`u-${g}`)} className="rounded-lg p-1.5 text-fg-3 hover:bg-raised hover:text-fg" aria-label={groupNames[g]}>
                  <Icon size={18} />
                </button>
              ) : null;
            })}
          </div>
        )}
        <div ref={scroller} className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {!all && (
            <div className="flex h-full items-center justify-center text-fg-3">
              <Loader2 className="anim-spin" />
            </div>
          )}
          {results ? (
            results.custom.length + results.unicode.length === 0 ? (
              <div className="p-6 text-center text-[14px] text-fg-3">{t("emoji.none")}</div>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,40px)] justify-between">
                {results.custom.map((e) => (
                  <Cell key={e.id} onClick={() => pickCustom(e)} label={`:${e.name}:`} img={e.url}>
                    <img src={mediaUrl(e.url, 48)} alt="" className="h-7 w-7 object-contain" />
                  </Cell>
                ))}
                {results.unicode.map((e) => (
                  <Cell key={e.char} onClick={() => pickUnicode(e)} label={e.codes[0] ? `:${e.codes[0]}:` : e.keywords.split("|")[0]}>
                    {withSkin(e, tone)}
                  </Cell>
                ))}
              </div>
            )
          ) : (
            <>
              {recentItems.length > 0 && (
                <Section id="recent" title={t("emoji.recent")}>
                  {recentItems.map((r, i) =>
                    "custom" in r ? (
                      <Cell key={i} onClick={() => pickCustom(r.custom)} label={`:${r.custom.name}:`} img={r.custom.url}>
                        <img src={mediaUrl(r.custom.url, 48)} alt="" className="h-7 w-7 object-contain" />
                      </Cell>
                    ) : (
                      <Cell key={i} onClick={() => onPick({ key: r.char, text: r.char })} label={r.char}>
                        {r.char}
                      </Cell>
                    )
                  )}
                </Section>
              )}
              {Object.entries(emojis)
                .filter(([, l]) => l.length)
                .map(([gid, list]) => (
                  <Section key={gid} id={`g-${gid}`} title={guilds[gid]?.name ?? t("emoji.custom")}>
                    {list.map((e) => (
                      <Cell key={e.id} onClick={() => pickCustom(e)} label={`:${e.name}:`} img={e.url}>
                        <img src={mediaUrl(e.url, 48)} alt="" loading="lazy" className="h-7 w-7 object-contain" />
                      </Cell>
                    ))}
                  </Section>
                ))}
              {groups.map(([g, list]) => (
                <Section key={g} id={`u-${g}`} title={groupNames[g] || ""}>
                  {list.map((e) => (
                    <Cell key={e.char} onClick={() => pickUnicode(e)} label={e.codes[0] ? `:${e.codes[0]}:` : e.keywords.split("|")[0]}>
                      {withSkin(e, tone)}
                    </Cell>
                  ))}
                </Section>
              ))}
            </>
          )}
        </div>
      </div>
      <div className="flex h-12 shrink-0 items-center gap-3 border-t border-line/10 px-3">
        {hover ? (
          <>
            {hover.img ? <img src={mediaUrl(hover.img, 64)} alt="" className="h-7 w-7 object-contain" /> : <span className="text-[26px] leading-none">{hover.char}</span>}
            <span className="truncate text-[13.5px] font-semibold text-fg-2">{hover.label}</span>
          </>
        ) : (
          <span className="text-[13px] text-fg-3">{t("emoji.search")}</span>
        )}
      </div>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section data-section={id} className="[content-visibility:auto] [contain-intrinsic-size:auto_320px]">
      <h4 className="sticky top-0 z-[1] bg-panel/95 px-1 pb-1 pt-2 text-[12px] font-semibold text-fg-3 backdrop-blur">{title}</h4>
      <div className="grid grid-cols-[repeat(auto-fill,40px)] justify-between">{children}</div>
    </section>
  );
}
