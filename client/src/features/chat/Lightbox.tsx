import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { ChevronLeft, ChevronRight, Download, ExternalLink, Minus, Plus, X } from "lucide-react";
import { useUI } from "../../store/ui";
import { isDesktop } from "../../lib/platform";
import { t } from "../../lib/i18n";

interface View {
  s: number;
  x: number;
  y: number;
}
const FIT: View = { s: 1, x: 0, y: 0 };

/**
 * Full-screen media viewer. A photo zooms where you point: the wheel or a
 * trackpad at the cursor, a pinch between the fingers, a double click or tap
 * into that spot; it pans by dragging and never leaves the screen. +/− and
 * "1:1" (the photo's own pixels) in the bar and on the keyboard; ←/→ browse.
 */
export function Lightbox() {
  const box = useUI((s) => s.lightbox);
  const [view, setView] = useState<View>(FIT);
  const [animate, setAnimate] = useState(true);
  const stage = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ view: View; x: number; y: number; d: number; moved: boolean; backdrop?: boolean } | null>(null);
  const lastTap = useRef({ at: 0, x: 0, y: 0 });
  const index = box?.index ?? 0;
  const item = box?.items[index];

  useEffect(() => setView(FIT), [index, box]);

  const go = useCallback(
    (d: number) => {
      if (!box) return;
      const n = box.items.length;
      useUI.setState({ lightbox: { ...box, index: (index + d + n) % n } });
    },
    [box, index]
  );
  const close = () => useUI.setState({ lightbox: null });

  /** The most it makes sense to zoom: past the photo's own pixels ×3, at least ×4 of the fitted size. */
  const maxScale = () => {
    const el = img.current;
    if (!el || !el.offsetWidth) return 8;
    return Math.max(4, (el.naturalWidth / el.offsetWidth) * 3);
  };

  /**
   * Keeps the photo on screen: while smaller than the stage it may sit anywhere inside it (so a
   * zoom stays anchored at the cursor from the first step), once bigger its edges don't come in
   * past the stage's.
   */
  const clamp = useCallback((v: View): View => {
    const el = img.current;
    const st = stage.current?.getBoundingClientRect();
    if (!el || !st) return v;
    const w = el.offsetWidth * v.s;
    const h = el.offsetHeight * v.s;
    const mx = Math.abs(w - st.width) / 2;
    const my = Math.abs(h - st.height) / 2;
    return { s: v.s, x: Math.min(mx, Math.max(-mx, v.x)), y: Math.min(my, Math.max(-my, v.y)) };
  }, []);

  /** Zoom to `s`, keeping the point under (px, py) — screen coordinates — where it is. */
  const zoomAt = useCallback(
    (from: View, s: number, px: number, py: number): View => {
      const st = stage.current?.getBoundingClientRect();
      const ns = Math.min(maxScale(), Math.max(1, s));
      if (!st || ns === 1) return FIT;
      const qx = px - (st.left + st.width / 2);
      const qy = py - (st.top + st.height / 2);
      const k = ns / from.s;
      return clamp({ s: ns, x: qx * (1 - k) + from.x * k, y: qy * (1 - k) + from.y * k });
    },
    [clamp]
  );

  const centre = () => {
    const st = stage.current?.getBoundingClientRect();
    return st ? { x: st.left + st.width / 2, y: st.top + st.height / 2 } : { x: 0, y: 0 };
  };
  const step = (k: number) => {
    setAnimate(true);
    setView((v) => zoomAt(v, v.s * k, centre().x, centre().y));
  };
  /** The photo's own pixels (or back to fitting the screen). */
  const actual = () => {
    const el = img.current;
    if (!el) return;
    setAnimate(true);
    const one = el.naturalWidth / el.offsetWidth;
    setView((v) => (Math.abs(v.s - one) < 0.01 || one <= 1 ? FIT : zoomAt(v, one, centre().x, centre().y)));
  };

  useEffect(() => {
    if (!box) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "+" || e.key === "=") step(1.5);
      else if (e.key === "-") step(1 / 1.5);
      else if (e.key === "0") setView(FIT);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Wheel zoom needs a non-passive listener to keep the page from scrolling.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!img.current) return;
      e.preventDefault();
      // Trackpads send many small deltas, mice a few big ones: zoom by the amount, not per event.
      const k = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0022));
      setAnimate(false);
      setView((v) => zoomAt(v, v.s * k, e.clientX, e.clientY));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [item, zoomAt]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (item?.type === "video") return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    const mid = { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length };
    const d = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    // (The stage captures the pointer, so where it went down is remembered here.)
    gesture.current = { view, x: mid.x, y: mid.y, d, moved: false, backdrop: e.target === e.currentTarget };
    setAnimate(false);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || !pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    const mid = { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length };
    if (Math.hypot(mid.x - g.x, mid.y - g.y) > 4) g.moved = true;
    if (pts.length > 1 && g.d) {
      // Pinch: zoom about where the fingers started, then follow them as they move.
      g.moved = true;
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const z = zoomAt(g.view, (g.view.s * d) / g.d, g.x, g.y);
      setView(clamp({ s: z.s, x: z.x + (mid.x - g.x), y: z.y + (mid.y - g.y) }));
    } else if (g.view.s > 1) {
      setView(clamp({ s: g.view.s, x: g.view.x + (mid.x - g.x), y: g.view.y + (mid.y - g.y) }));
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size) {
      // A finger lifted mid-pinch: carry on panning with the other one from here.
      const [p] = pointers.current.values();
      gesture.current = { view, x: p.x, y: p.y, d: 0, moved: true };
      return;
    }
    gesture.current = null;
    if (!g || g.moved) return;
    // A tap/click: double → zoom into that spot (or back); on the backdrop, single → close.
    const now = performance.now();
    const dbl = now - lastTap.current.at < 320 && Math.hypot(e.clientX - lastTap.current.x, e.clientY - lastTap.current.y) < 30;
    lastTap.current = { at: dbl ? 0 : now, x: e.clientX, y: e.clientY };
    if (dbl) {
      setAnimate(true);
      setView((v) => (v.s > 1.05 ? FIT : zoomAt(v, 2.5, e.clientX, e.clientY)));
    } else if (g.backdrop && view.s === 1) {
      const at = now;
      setTimeout(() => lastTap.current.at === at && close(), 330);
    }
  };

  const zoomed = view.s > 1.01;
  const btn = "rounded-xl p-2.5 text-white/80 hover:bg-white/10 hover:text-white";
  return createPortal(
    <AnimatePresence>
      {box && item && (
        <motion.div className="app-layer z-[85] flex flex-col bg-[rgb(3_4_10/0.92)]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="absolute right-3 top-3 z-10 flex items-center gap-1">
            {item.type !== "video" && (
              <div className="mr-1 flex items-center gap-0.5 rounded-xl bg-white/5 px-1" data-zoom={Math.round(view.s * 100)}>
                <button onClick={() => step(1 / 1.5)} disabled={!zoomed} className={`${btn} p-2 disabled:opacity-30`} aria-label={t("lightbox.zoomOut")}>
                  <Minus size={18} />
                </button>
                <button onClick={actual} className="min-w-[56px] rounded-lg px-1.5 py-1 text-[13px] font-semibold tabular-nums text-white/80 hover:bg-white/10 hover:text-white" title={t("lightbox.actualSize")}>
                  {Math.round(view.s * 100)}%
                </button>
                <button onClick={() => step(1.5)} className={`${btn} p-2`} aria-label={t("lightbox.zoomIn")}>
                  <Plus size={18} />
                </button>
              </div>
            )}
            <a href={item.url + (item.url.includes("?") ? "&" : "?") + "download=1"} download={item.name} className={btn} aria-label={t("common.download")}>
              <Download size={20} />
            </a>
            <button onClick={() => (isDesktop ? window.nova!.openExternal(item.url) : window.open(item.url, "_blank"))} className={btn} aria-label={t("common.openInBrowser")}>
              <ExternalLink size={20} />
            </button>
            <button onClick={close} className={btn} aria-label={t("common.close")}>
              <X size={22} />
            </button>
          </div>
          {box.items.length > 1 && !zoomed && (
            <>
              <button onClick={() => go(-1)} className="absolute left-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-white/10 p-2.5 text-white hover:bg-white/20" aria-label={t("common.back")}>
                <ChevronLeft size={24} />
              </button>
              <button onClick={() => go(1)} className="absolute right-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-white/10 p-2.5 text-white hover:bg-white/20" aria-label={t("common.forward")}>
                <ChevronRight size={24} />
              </button>
            </>
          )}
          <div
            ref={stage}
            className="relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            style={{ cursor: zoomed ? (gesture.current ? "grabbing" : "grab") : "zoom-in" }}
          >
            {item.type === "video" ? (
              <video src={item.url} controls autoPlay className="max-h-[90%] max-w-[92%] rounded-xl" />
            ) : (
              <motion.div key={item.url} initial={{ scale: 0.92, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 420, damping: 32 }} className="flex max-h-full max-w-full items-center justify-center">
                <img
                  ref={img}
                  src={item.url}
                  alt={item.name ?? ""}
                  draggable={false}
                  data-lightbox-image
                  className="max-h-[calc(100vh-var(--chrome-top,0px)-96px)] max-w-[92vw] select-none rounded-lg object-contain"
                  style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`, transition: animate ? "transform 160ms ease-out" : "none", willChange: "transform" }}
                />
              </motion.div>
            )}
          </div>
          {box.items.length > 1 && <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-white/10 px-3 py-1 text-[13px] text-white/80">{index + 1} / {box.items.length}</div>}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
