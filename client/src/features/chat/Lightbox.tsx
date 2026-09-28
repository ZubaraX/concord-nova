import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { ChevronLeft, ChevronRight, Download, ExternalLink, X } from "lucide-react";
import { useUI } from "../../store/ui";
import { isDesktop } from "../../lib/platform";
import { t } from "../../lib/i18n";

/** Full-screen media viewer: wheel/pinch zoom, drag to pan, ←/→ to browse. */
export function Lightbox() {
  const box = useUI((s) => s.lightbox);
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const pinch = useRef<{ d: number; s: number } | null>(null);
  const index = box?.index ?? 0;
  const item = box?.items[index];

  useEffect(() => {
    setScale(1);
    setPos({ x: 0, y: 0 });
  }, [index, box]);

  const go = (d: number) => {
    if (!box) return;
    const n = box.items.length;
    useUI.setState({ lightbox: { ...box, index: (index + d + n) % n } });
  };
  const close = () => useUI.setState({ lightbox: null });

  useEffect(() => {
    if (!box) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return createPortal(
    <AnimatePresence>
      {box && item && (
        <motion.div className="fixed inset-0 z-[85] flex items-center justify-center bg-[rgb(3_4_10/0.92)]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && close()}>
          <div className="absolute right-3 top-3 z-10 flex gap-1">
            <a href={item.url + (item.url.includes("?") ? "&" : "?") + "download=1"} download={item.name} className="rounded-xl p-2.5 text-white/80 hover:bg-white/10 hover:text-white" aria-label={t("common.download")}>
              <Download size={20} />
            </a>
            <button onClick={() => (isDesktop ? window.nova!.openExternal(item.url) : window.open(item.url, "_blank"))} className="rounded-xl p-2.5 text-white/80 hover:bg-white/10 hover:text-white" aria-label={t("common.openInBrowser")}>
              <ExternalLink size={20} />
            </button>
            <button onClick={close} className="rounded-xl p-2.5 text-white/80 hover:bg-white/10 hover:text-white" aria-label={t("common.close")}>
              <X size={22} />
            </button>
          </div>
          {box.items.length > 1 && (
            <>
              <button onClick={() => go(-1)} className="absolute left-3 z-10 rounded-full bg-white/10 p-2.5 text-white hover:bg-white/20" aria-label={t("common.back")}>
                <ChevronLeft size={24} />
              </button>
              <button onClick={() => go(1)} className="absolute right-3 z-10 rounded-full bg-white/10 p-2.5 text-white hover:bg-white/20" aria-label={t("common.forward")}>
                <ChevronRight size={24} />
              </button>
            </>
          )}
          {item.type === "video" ? (
            <video src={item.url} controls autoPlay className="max-h-[90vh] max-w-[92vw] rounded-xl" />
          ) : (
            <motion.img
              key={item.url}
              src={item.url}
              alt={item.name ?? ""}
              draggable={false}
              initial={{ scale: 0.92, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 420, damping: 32 }}
              onWheel={(e) => setScale((s) => Math.min(8, Math.max(1, s * (e.deltaY < 0 ? 1.15 : 0.87))))}
              onDoubleClick={() => {
                setScale((s) => (s > 1 ? 1 : 2.5));
                setPos({ x: 0, y: 0 });
              }}
              onPointerDown={(e) => {
                if (scale <= 1) return;
                (e.target as HTMLElement).setPointerCapture(e.pointerId);
                drag.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y };
              }}
              onPointerMove={(e) => {
                if (!drag.current) return;
                setPos({ x: drag.current.px + (e.clientX - drag.current.x), y: drag.current.py + (e.clientY - drag.current.y) });
              }}
              onPointerUp={() => (drag.current = null)}
              onTouchStart={(e) => {
                if (e.touches.length === 2) {
                  const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
                  pinch.current = { d, s: scale };
                }
              }}
              onTouchMove={(e) => {
                if (e.touches.length === 2 && pinch.current) {
                  const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
                  setScale(Math.min(8, Math.max(1, (pinch.current.s * d) / pinch.current.d)));
                }
              }}
              onTouchEnd={() => (pinch.current = null)}
              className="max-h-[90vh] max-w-[92vw] select-none rounded-lg object-contain"
              style={{ transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})`, cursor: scale > 1 ? "grab" : "zoom-in", transition: drag.current ? "none" : "transform 120ms ease-out" }}
            />
          )}
          {box.items.length > 1 && <div className="absolute bottom-4 rounded-full bg-white/10 px-3 py-1 text-[13px] text-white/80">{index + 1} / {box.items.length}</div>}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
