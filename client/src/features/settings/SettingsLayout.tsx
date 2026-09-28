import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import clsx from "clsx";
import { X, ArrowLeft } from "lucide-react";
import { useIsMobile } from "../../lib/hooks";
import { t } from "../../lib/i18n";

export interface NavItem {
  id: string;
  label: string;
  danger?: boolean;
  onClick?: () => void;
}

/** Full-screen settings shell (user & server settings), Discord-style. */
export function SettingsLayout({
  sections,
  active,
  onSelect,
  onClose,
  children,
}: {
  sections: { title?: string; items: NavItem[] }[];
  active: string | null;
  onSelect: (id: string | null) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const mobile = useIsMobile();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector('[role="dialog"]:not([data-settings])')) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const nav = (
    <nav className="scroll-thin flex w-full flex-col gap-0.5 overflow-y-auto px-3 py-6 md:w-[232px] md:py-14">
      {sections.map((sec, i) => (
        <div key={i} className="mb-2">
          {sec.title && <div className="truncate px-2.5 pb-1.5 text-[12px] font-semibold text-fg-3">{sec.title}</div>}
          {sec.items.map((it) => (
            <button
              key={it.id}
              onClick={() => (it.onClick ? it.onClick() : onSelect(it.id))}
              className={clsx(
                "w-full rounded-lg px-2.5 py-2 text-left text-[15px] font-medium transition-colors",
                active === it.id ? "bg-raised text-fg" : it.danger ? "text-bad hover:bg-bad/10" : "text-fg-2 hover:bg-raised/60 hover:text-fg"
              )}
            >
              {it.label}
            </button>
          ))}
          {i < sections.length - 1 && <div className="mx-2.5 my-2 h-px bg-line/10" />}
        </div>
      ))}
    </nav>
  );

  return createPortal(
    <motion.div
      data-settings
      className="fixed inset-0 z-[55] flex bg-surface"
      initial={{ opacity: 0, scale: 1.02 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.18 }}
    >
      {mobile ? (
        active ? (
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-12 items-center gap-2 border-b border-line/10 px-2">
              <button onClick={() => onSelect(null)} className="rounded-lg p-2 text-fg-2" aria-label={t("common.back")}>
                <ArrowLeft size={20} />
              </button>
            </div>
            <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-5">{children}</div>
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-12 items-center justify-end border-b border-line/10 px-2">
              <button onClick={onClose} className="rounded-lg p-2 text-fg-2" aria-label={t("common.close")}>
                <X size={22} />
              </button>
            </div>
            {nav}
          </div>
        )
      ) : (
        <>
          <div className="flex flex-1 justify-end bg-panel">{nav}</div>
          <div className="flex flex-[1.6] min-w-0">
            <div className="scroll-thin min-w-0 max-w-[760px] flex-1 overflow-y-auto px-10 py-14">{children}</div>
            <div className="shrink-0 py-14 pr-6">
              <button onClick={onClose} className="flex flex-col items-center gap-1 text-fg-3 hover:text-fg" aria-label={t("common.close")}>
                <span className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-current">
                  <X size={18} />
                </span>
                <span className="text-[12px] font-semibold">ESC</span>
              </button>
            </div>
          </div>
        </>
      )}
    </motion.div>,
    document.body
  );
}

export function SectionTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mb-6">
      <h2 className="font-display text-[22px] font-semibold tracking-[-0.015em]">{children}</h2>
      {sub && <p className="mt-1.5 text-[14px] text-fg-2">{sub}</p>}
    </div>
  );
}

export function Group({ title, children, className }: { title?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={clsx("mb-8", className)}>
      {title && <h3 className="mb-2 text-[13px] font-semibold text-fg-3">{title}</h3>}
      <div className="divide-y divide-line/8">{children}</div>
    </section>
  );
}
