// The music player in the corner of the app: a shared Yandex Music / VK link
// playing on this device. It outlives the radio panel, and folds into a bar.
// Desktop app: the service's own page in a <webview> (signed in there once),
// at our volume. Browser: Yandex's widget, at the system's volume.
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { useShallow } from "zustand/react/shallow";
import { ArrowLeft, ChevronDown, ChevronUp, Home, Music, Volume2, X } from "lucide-react";
import type { RadioLinkDTO } from "@nova/shared";
import { t } from "../../lib/i18n";
import { isDesktop } from "../../lib/platform";
import { settings, useSettings } from "../../store/settings";
import { Tooltip } from "../../components/ui/overlay";
import { Slider } from "../../components/ui/primitives";
import { useVoice } from "./voice";
import { closeMusic, setMusicMin, useMusic } from "./music";
import { vkHome, yandexEmbed } from "./musicLinks";

export function MusicDock() {
  const { link, min } = useMusic(useShallow((s) => ({ link: s.link, min: s.min })));
  return link ? <Dock key={link.id} link={link} min={min} /> : null;
}

const btn = "grid h-7 w-7 shrink-0 place-items-center rounded-lg text-fg-3 hover:bg-raised hover:text-fg";

function Dock({ link, min }: { link: RadioLinkDTO; min: boolean }) {
  const embed = yandexEmbed(link.url);
  const src = embed?.src ?? vkHome(link.url);
  // A whole site (VK, or a Yandex page without a widget) needs room; the widget doesn't.
  const site = !embed;
  // (Kept clear of the title bar and the call's buttons.)
  const width = site ? "min(720px, calc(100vw - 32px))" : "min(420px, calc(100vw - 32px))";
  const height = site ? "min(560px, calc(100vh - 330px))" : `min(${embed.height}px, calc(100vh - 330px))`;
  const view = useRef<HTMLWebViewElement>(null);
  const [canBack, setCanBack] = useState(false);
  const volume = useSettings((s) => s.musicVolume ?? 60);
  const factor = useMusicFactor();

  return (
    <div
      data-music-dock
      data-min={min ? "" : undefined}
      className="menu-surface fixed bottom-[88px] right-4 z-[55] flex flex-col overflow-hidden rounded-2xl shadow-lift anim-pop"
      style={{ width: min ? "min(360px, calc(100vw - 32px))" : width }}
    >
      <div className="flex items-center gap-1.5 px-2.5 py-1.5">
        <Music size={15} className="shrink-0 text-star" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{link.title ?? t(`radio.service.${link.service}`)}</span>
        {isDesktop && !min && (
          <>
            {canBack && (
              <Tooltip content={t("music.back")}>
                <button onClick={() => view.current?.goBack()} className={btn} aria-label={t("music.back")}>
                  <ArrowLeft size={15} />
                </button>
              </Tooltip>
            )}
            <Tooltip content={t("music.home")}>
              <button onClick={() => void view.current?.loadURL(src)} className={btn} aria-label={t("music.home")}>
                <Home size={15} />
              </button>
            </Tooltip>
          </>
        )}
        <Tooltip content={min ? t("music.expand") : t("music.minimize")}>
          <button onClick={() => setMusicMin(!min)} className={btn} aria-label={min ? t("music.expand") : t("music.minimize")}>
            {min ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </Tooltip>
        <Tooltip content={t("music.close")}>
          <button onClick={closeMusic} className={btn} aria-label={t("music.close")}>
            <X size={15} />
          </button>
        </Tooltip>
      </div>

      {/* Folded, the player moves off screen rather than away: it keeps playing. */}
      <div className={clsx(min && "pointer-events-none fixed -left-[10000px] top-0")} style={{ width, height }}>
        {isDesktop ? (
          <MusicView ref={view} src={src} zoom={site ? 0.75 : 1} factor={factor} onNavigate={setCanBack} />
        ) : (
          <iframe src={src} title={link.title ?? link.url} allow="clipboard-write; autoplay; encrypted-media" className="h-full w-full border-0 bg-canvas" />
        )}
      </div>

      {isDesktop ? (
        <div className="flex items-center gap-2 px-3 py-2">
          <Volume2 size={15} className="shrink-0 text-fg-3" aria-label={t("music.volume")} />
          <Slider value={volume} onChange={(v) => settings().setLocal({ musicVolume: v })} format={(v) => `${v}%`} className="min-w-0 flex-1" />
        </div>
      ) : (
        !min && <p className="px-3 py-2 text-[11px] leading-snug text-fg-3">{t("music.webVolume")}</p>
      )}
      {isDesktop && !min && <p className="px-3 pb-2 text-[11px] leading-snug text-fg-3">{t("music.signIn")}</p>}
    </div>
  );
}

/** The player's volume (0–1): its own slider × the app's output volume, silent when deafened. */
function useMusicFactor() {
  const own = useSettings((s) => s.musicVolume ?? 60);
  const output = useSettings((s) => s.outputVolume ?? 100);
  const deaf = useVoice((s) => s.deafened && !!s.channelId);
  return deaf ? 0 : (own / 100) * Math.min(1, output / 100);
}

/** The service's page in the desktop app's music session; main.cjs holds it to those sites. */
function MusicView({ ref, src, zoom, factor, onNavigate }: { ref: React.RefObject<HTMLWebViewElement | null>; src: string; zoom: number; factor: number; onNavigate: (canBack: boolean) => void }) {
  const [ready, setReady] = useState(false);
  const live = useRef({ factor, zoom, onNavigate });
  live.current = { factor, zoom, onNavigate };

  useEffect(() => {
    const w = ref.current;
    if (!w || typeof w.send !== "function") return; // (not Electron: the tests)
    // Every page it opens starts at full volume until told: tell it as soon as it's up.
    const up = () => {
      setReady(true);
      if (live.current.zoom !== 1) w.setZoomFactor(live.current.zoom);
      w.send("nova:volume", live.current.factor);
      live.current.onNavigate(w.canGoBack());
    };
    const moved = () => live.current.onNavigate(w.canGoBack());
    w.addEventListener("dom-ready", up);
    w.addEventListener("did-navigate-in-page", moved);
    return () => {
      w.removeEventListener("dom-ready", up);
      w.removeEventListener("did-navigate-in-page", moved);
    };
  }, [ref]);

  useEffect(() => {
    if (ready) ref.current?.send("nova:volume", factor);
  }, [ready, factor, ref]);

  // (allowpopups as a string: React drops a boolean attribute it doesn't know, and signing in needs pop-ups.)
  return <webview ref={ref} src={src} partition="persist:music" {...({ allowpopups: "true" } as object)} className="h-full w-full" />;
}
