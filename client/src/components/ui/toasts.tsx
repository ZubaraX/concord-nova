import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import clsx from "clsx";
import { CheckCircle2, AlertTriangle, Info } from "lucide-react";
import { bus, type BusEvents } from "../../lib/bus";

type Item = BusEvents["toast"] & { id: number };

let seq = 0;

export function Toasts() {
  const [items, setItems] = useState<Item[]>([]);
  useEffect(
    () =>
      bus.on("toast", (t) => {
        const id = ++seq;
        setItems((cur) => [...cur.slice(-3), { ...t, id }]);
        setTimeout(() => setItems((cur) => cur.filter((x) => x.id !== id)), t.action ? 7000 : 3800);
      }),
    []
  );
  return (
    <div className="pointer-events-none fixed inset-x-0 top-12 z-[80] flex flex-col items-center gap-2 px-4">
      <AnimatePresence>
        {items.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: -16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 500, damping: 34 }}
            className="menu-surface pointer-events-auto flex max-w-md items-center gap-3 rounded-xl px-4 py-3 text-[14px] shadow-lift"
          >
            {t.kind === "error" ? <AlertTriangle size={18} className="shrink-0 text-bad" /> : t.kind === "success" ? <CheckCircle2 size={18} className="shrink-0 text-ok" /> : <Info size={18} className="shrink-0 text-star" />}
            <span className="min-w-0 flex-1">{t.text}</span>
            {t.action && (
              <button
                onClick={() => {
                  t.action!.run();
                  setItems((cur) => cur.filter((x) => x.id !== t.id));
                }}
                className={clsx("shrink-0 rounded-lg px-2.5 py-1 text-[13px] font-semibold text-star hover:bg-star/15")}
              >
                {t.action.label}
              </button>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
