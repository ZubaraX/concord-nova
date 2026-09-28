import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Download, WifiOff, Loader2, Volume2, RefreshCw, X } from "lucide-react";
import { useConnection } from "../../lib/gateway";
import { t } from "../../lib/i18n";
import { isAndroid, isDesktop, isNative } from "../../lib/platform";
import { newerAndroidBuild } from "../../lib/android";
import { serverBase } from "../../lib/server";
import { useData } from "../../store/data";
import { unlockAudio, useVoice } from "../voice/voice";

/** The server now serves a newer web build than this tab runs (web, same origin only — apps update themselves). */
const isStaleWeb = (served: string | null | undefined) => !!served && !!__NOVA_BUILD__ && served !== __NOVA_BUILD__ && !isNative && !serverBase();

/** Thin status strip: reconnecting / offline / update ready / audio blocked. */
export function ConnectionBanner() {
  const state = useConnection((s) => s.state);
  const since = useConnection((s) => s.since);
  const needsAudio = useVoice((s) => s.needsAudioUnlock);
  const staleWeb = useData((s) => isStaleWeb(s.server?.webBuild));
  const [update, setUpdate] = useState<{ state: string; version?: string; percent?: number } | null>(null);
  const [visible, setVisible] = useState(false);
  const [apk, setApk] = useState<{ version: string; url: string } | null>(null);

  useEffect(() => (isDesktop ? window.nova!.onUpdate(setUpdate) : undefined), []);
  useEffect(() => {
    if (isAndroid) void newerAndroidBuild().then(setApk);
  }, []);

  // Don't flash the banner for sub-second blips.
  useEffect(() => {
    if (state === "ready") return setVisible(false);
    const id = setTimeout(() => setVisible(true), 1500);
    return () => clearTimeout(id);
  }, [state, since]);

  let content: React.ReactNode = null;
  let tone = "bg-warn/15 text-warn";
  if (visible && state === "offline") {
    content = (
      <>
        <WifiOff size={15} /> {t("app.offline")}
      </>
    );
  } else if (visible && state === "reconnecting") {
    content = (
      <>
        <Loader2 size={15} className="anim-spin" /> {t("app.reconnecting")}
      </>
    );
  } else if (needsAudio) {
    tone = "bg-star/15 text-star";
    content = (
      <button onClick={() => void unlockAudio()} className="flex items-center gap-2 font-semibold">
        <Volume2 size={15} /> {t("voice.unlockAudio")}
      </button>
    );
  } else if (update?.state === "downloaded") {
    tone = "bg-ok/15 text-ok";
    content = (
      <button onClick={() => window.nova!.installUpdate()} className="flex items-center gap-2 font-semibold">
        <Download size={15} /> {t("app.updateReady", { v: update.version ?? "" })} — {t("app.updateRestart")}
      </button>
    );
  } else if (apk) {
    tone = "bg-ok/15 text-ok";
    content = (
      <>
        <button onClick={() => window.open(apk.url, "_blank")} className="flex items-center gap-2 font-semibold">
          <Download size={15} /> {t("app.androidUpdate", { v: apk.version })}
        </button>
        <button onClick={() => setApk(null)} className="rounded p-1 opacity-70 hover:opacity-100" aria-label={t("common.close")}>
          <X size={14} />
        </button>
      </>
    );
  } else if (staleWeb) {
    tone = "bg-star/15 text-star";
    content = (
      <button onClick={() => location.reload()} className="flex items-center gap-2 font-semibold">
        <RefreshCw size={15} /> {t("app.webUpdate")}
      </button>
    );
  }

  return (
    <AnimatePresence initial={false}>
      {content && (
        <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 32, opacity: 1 }} exit={{ height: 0, opacity: 0 }} className={`flex shrink-0 items-center justify-center gap-2 overflow-hidden text-[13px] ${tone}`}>
          {content}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
