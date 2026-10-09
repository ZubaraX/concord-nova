// Modals, anchored popovers/menus and tooltips — all portaled, viewport-aware,
// keyboard-closable, and animated as a response to the action that opened them.
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import clsx from "clsx";
import { ChevronRight, X } from "lucide-react";
import { t } from "../../lib/i18n";

// ── Modal ────────────────────────────────────────────────────────────────────
export function Modal({
  open,
  onClose,
  children,
  className,
  width = 480,
  closeButton = true,
  label,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  width?: number | string;
  closeButton?: boolean;
  label?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="app-layer z-[58] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <div className="absolute inset-0 bg-[rgb(4_5_12/0.72)] backdrop-blur-[3px]" onMouseDown={onClose} />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={label}
            className={clsx("relative max-h-[calc(100dvh-2rem)] w-full overflow-hidden rounded-[18px] bg-surface text-fg shadow-lift hairline", className)}
            style={{ maxWidth: width }}
            initial={{ opacity: 0, scale: 0.94, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 6 }}
            transition={{ type: "spring", stiffness: 520, damping: 34, mass: 0.7 }}
          >
            {closeButton && (
              <button aria-label={t("common.close")} onClick={onClose} className="absolute right-3 top-3 z-10 rounded-lg p-1.5 text-fg-3 transition-colors hover:bg-raised hover:text-fg">
                <X size={20} />
              </button>
            )}
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}

export function ModalHeader({ title, subtitle, className }: { title: ReactNode; subtitle?: ReactNode; className?: string }) {
  return (
    <div className={clsx("px-6 pb-2 pt-6", className)}>
      <h2 className="pr-8 font-display text-[19px] font-semibold leading-tight tracking-[-0.01em]">{title}</h2>
      {subtitle && <p className="mt-2 text-[14px] leading-snug text-fg-2">{subtitle}</p>}
    </div>
  );
}

export function ModalFooter({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx("flex items-center justify-end gap-2 bg-panel/60 px-6 py-4", className)}>{children}</div>;
}

// ── positioning ──────────────────────────────────────────────────────────────
export type Placement = "top" | "bottom" | "left" | "right" | "bottom-start" | "bottom-end" | "top-start" | "top-end" | "right-start" | "left-start";

export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export function pointRect(x: number, y: number): AnchorRect {
  return { left: x, top: y, right: x, bottom: y, width: 0, height: 0 };
}

function place(anchor: AnchorRect, w: number, h: number, placement: Placement, gap = 8) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let x = 0;
  let y = 0;
  const [side, align] = placement.split("-") as [string, string | undefined];
  const flipV = side === "bottom" && anchor.bottom + gap + h > vh && anchor.top - gap - h > 0;
  const flipV2 = side === "top" && anchor.top - gap - h < 0;
  const flipH = side === "right" && anchor.right + gap + w > vw;
  const s = flipV ? "top" : flipV2 ? "bottom" : flipH ? "left" : side;
  if (s === "bottom" || s === "top") {
    y = s === "bottom" ? anchor.bottom + gap : anchor.top - gap - h;
    x = align === "start" ? anchor.left : align === "end" ? anchor.right - w : anchor.left + anchor.width / 2 - w / 2;
  } else {
    x = s === "right" ? anchor.right + gap : anchor.left - gap - w;
    y = align === "start" ? anchor.top : anchor.top + anchor.height / 2 - h / 2;
  }
  x = Math.max(8, Math.min(x, vw - w - 8));
  y = Math.max(8, Math.min(y, vh - h - 8));
  return { x, y, side: s };
}

// ── Popover ──────────────────────────────────────────────────────────────────
export function Popover({
  anchor,
  onClose,
  children,
  placement = "bottom-start",
  className,
  gap,
}: {
  anchor: AnchorRect | null;
  onClose: () => void;
  children: ReactNode;
  placement?: Placement;
  className?: string;
  gap?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; side: string } | null>(null);

  useLayoutEffect(() => {
    if (!anchor || !ref.current) return setPos(null);
    // Layout size, not the painted box: a reopened popover is already mid pop-in
    // (scaled down), and measuring that put it a few pixels off its anchor.
    setPos(place(anchor, ref.current.offsetWidth, ref.current.offsetHeight, placement, gap));
  }, [anchor, placement, gap]);

  useEffect(() => {
    if (!anchor) return;
    const down = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const t = setTimeout(() => {
      window.addEventListener("mousedown", down, true);
      window.addEventListener("touchstart", down, true);
    }, 0);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", onClose);
    return () => {
      clearTimeout(t);
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("touchstart", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", onClose);
    };
  }, [anchor, onClose]);

  if (!anchor) return null;
  return createPortal(
    <div
      ref={ref}
      className={clsx("fixed z-[60]", !pos && "invisible", pos && "anim-pop", className)}
      style={{ left: pos?.x ?? 0, top: pos?.y ?? 0, transformOrigin: pos?.side === "top" ? "bottom" : "top" }}
    >
      {children}
    </div>,
    document.body
  );
}

export function usePopover() {
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  const open = useCallback((e: { currentTarget: Element } | AnchorRect) => {
    setAnchor("currentTarget" in e ? e.currentTarget.getBoundingClientRect() : e);
  }, []);
  const toggle = useCallback((e: { currentTarget: Element }) => {
    // Measure now: React may run the updater after the event is done, when
    // currentTarget is already null (that crashed the composer's emoji button).
    const rect = e.currentTarget.getBoundingClientRect();
    setAnchor((a) => (a ? null : rect));
  }, []);
  const close = useCallback(() => setAnchor(null), []);
  return { anchor, open, toggle, close };
}

// ── Menu ─────────────────────────────────────────────────────────────────────
export interface MenuItem {
  label?: ReactNode;
  icon?: ReactNode;
  hint?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  onSelect?: () => void;
  separator?: boolean;
  keepOpen?: boolean;
  submenu?: MenuItem[];
}

export type MenuEntry = MenuItem | false | null | undefined | "";

/** Drop hidden entries, then separators at the edges or next to each other. */
function tidy(items: MenuEntry[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const it of items.filter(Boolean) as MenuItem[]) {
    if (it.separator && (!out.length || out[out.length - 1].separator)) continue;
    out.push(it);
  }
  while (out.length && out[out.length - 1].separator) out.pop();
  return out;
}

export function MenuList({ items, onClose, className }: { items: MenuEntry[]; onClose: () => void; className?: string }) {
  // A submenu opens in place, under its entry (works the same with a mouse and a finger).
  const [expanded, setExpanded] = useState<number | null>(null);
  const top = tidy(items);
  const list: (MenuItem & { sub?: boolean; parent?: number })[] = [];
  top.forEach((it, i) => {
    list.push({ ...it, parent: it.submenu ? i : undefined });
    if (it.submenu && expanded === i) for (const s of it.submenu) list.push({ ...s, sub: true });
  });
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: React.KeyboardEvent) => {
    const enabled = refs.current.filter((b): b is HTMLButtonElement => !!b && !b.disabled);
    const i = enabled.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      enabled[(i + 1) % enabled.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      enabled[(i - 1 + enabled.length) % enabled.length]?.focus();
    }
  };
  return (
    <div role="menu" onKeyDown={onKey} className={clsx("menu-surface min-w-[200px] max-w-[300px] rounded-xl p-1.5 shadow-lift", className)}>
      {list.map((it, i) =>
        it.separator ? (
          <div key={i} className="mx-2 my-1 h-px bg-line/10" />
        ) : (
          <button
            key={i}
            ref={(el) => {
              refs.current[i] = el;
            }}
            role="menuitem"
            data-checked={it.checked}
            aria-expanded={it.parent !== undefined ? expanded === it.parent : undefined}
            disabled={it.disabled}
            onClick={() => {
              if (it.parent !== undefined) return setExpanded((e) => (e === it.parent ? null : it.parent!));
              it.onSelect?.();
              if (!it.keepOpen) onClose();
            }}
            className={clsx(
              "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[14px] font-medium outline-none transition-colors disabled:opacity-40",
              it.sub && "pl-9 text-[13.5px]",
              it.danger ? "text-bad hover:bg-bad hover:text-white focus:bg-bad focus:text-white" : "text-fg-2 hover:bg-star/90 hover:text-on-star focus:bg-star/90 focus:text-on-star"
            )}
          >
            {it.icon && <span className="flex w-4 shrink-0 justify-center opacity-90">{it.icon}</span>}
            <span className="min-w-0 flex-1 truncate">{it.label}</span>
            {it.parent !== undefined && <ChevronRight size={15} className={clsx("shrink-0 opacity-60 transition-transform", expanded === it.parent && "rotate-90")} />}
            {it.checked !== undefined && (
              <span className={clsx("h-4 w-4 rounded-full border-2", it.checked ? "border-current bg-current" : "border-current opacity-50")} />
            )}
            {it.hint && <span className="text-[12px] opacity-60">{it.hint}</span>}
          </button>
        )
      )}
    </div>
  );
}

// Global context menu (right-click / long-press).
interface CtxState {
  anchor: AnchorRect;
  items: MenuEntry[];
}
const CtxMenuContext = createContext<(e: { clientX: number; clientY: number; preventDefault?: () => void } | AnchorRect, items: CtxState["items"]) => void>(() => {});

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CtxState | null>(null);
  const open = useCallback((e: { clientX: number; clientY: number; preventDefault?: () => void } | AnchorRect, items: CtxState["items"]) => {
    if ("clientX" in e) {
      e.preventDefault?.();
      setState({ anchor: pointRect(e.clientX, e.clientY), items });
    } else setState({ anchor: e, items });
  }, []);
  const close = useCallback(() => setState(null), []);
  return (
    <CtxMenuContext.Provider value={open}>
      {children}
      <Popover anchor={state?.anchor ?? null} onClose={close} placement="right-start" gap={2}>
        {state && <MenuList items={state.items} onClose={close} />}
      </Popover>
    </CtxMenuContext.Provider>
  );
}

export const useContextMenu = () => useContext(CtxMenuContext);

/** Long-press on touch devices behaves like a right-click. */
export function useLongPress(cb: (e: { clientX: number; clientY: number }) => void, ms = 450) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const start = useRef<{ x: number; y: number } | null>(null);
  return {
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0];
      start.current = { x: t.clientX, y: t.clientY };
      timer.current = setTimeout(() => {
        navigator.vibrate?.(12);
        cb({ clientX: t.clientX, clientY: t.clientY });
        start.current = null;
      }, ms);
    },
    onTouchMove: (e: React.TouchEvent) => {
      const t = e.touches[0];
      if (start.current && Math.hypot(t.clientX - start.current.x, t.clientY - start.current.y) > 10) clearTimeout(timer.current);
    },
    onTouchEnd: () => clearTimeout(timer.current),
    onTouchCancel: () => clearTimeout(timer.current),
  };
}

// ── Tooltip ──────────────────────────────────────────────────────────────────
export function Tooltip({ content, children, placement = "top", delay = 350, disabled }: { content: ReactNode; children: ReactNode; placement?: Placement; delay?: number; disabled?: boolean }) {
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useLayoutEffect(() => {
    if (!anchor || !tipRef.current) return;
    const r = tipRef.current.getBoundingClientRect();
    setPos(place(anchor, r.width, r.height, placement, 8));
  }, [anchor, placement]);

  useEffect(() => () => clearTimeout(timer.current), []);

  if (disabled || !content) return <>{children}</>;
  return (
    <span
      className="contents"
      onMouseEnter={(e) => {
        const el = (e.target as HTMLElement).closest("[data-tip]") ?? (e.currentTarget.firstElementChild as HTMLElement | null);
        const rect = (el ?? (e.target as HTMLElement)).getBoundingClientRect();
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setAnchor(rect), delay);
      }}
      onMouseLeave={() => {
        clearTimeout(timer.current);
        setAnchor(null);
        setPos(null);
      }}
      onMouseDown={() => {
        clearTimeout(timer.current);
        setAnchor(null);
      }}
    >
      {children}
      {anchor &&
        createPortal(
          <div
            ref={tipRef}
            role="tooltip"
            className={clsx("pointer-events-none fixed z-[70] max-w-[260px] rounded-lg bg-canvas px-2.5 py-1.5 text-[13px] font-semibold text-fg shadow-lift hairline", pos ? "anim-pop" : "invisible")}
            style={{ left: pos?.x ?? 0, top: pos?.y ?? 0 }}
          >
            {content}
          </div>,
          document.body
        )}
    </span>
  );
}
