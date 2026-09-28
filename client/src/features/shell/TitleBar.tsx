import { useEffect, useState } from "react";
import { Minus, Square, Copy, X } from "lucide-react";
import { NovaStar } from "../../components/Logo";
import { useConnection } from "../../lib/gateway";
import { t } from "../../lib/i18n";

/** Frameless window chrome for the desktop app (drag area + window controls). */
export function TitleBar() {
  const [max, setMax] = useState(() => window.nova?.window.isMaximized() ?? false);
  const conn = useConnection((s) => s.state);
  useEffect(() => window.nova?.window.onMaximizeChange(setMax), []);
  const btn = "no-drag flex h-8 w-11 items-center justify-center text-fg-3 transition-colors hover:bg-raised hover:text-fg";
  return (
    <div className="drag-region relative z-50 flex h-8 shrink-0 items-center select-none">
      <div className="flex items-center gap-2 pl-3">
        <NovaStar size={14} />
        <span className="text-[12px] font-semibold text-fg-3">Concord Nova</span>
        {conn !== "ready" && conn !== "connecting" && <span className="text-[12px] text-warn">· {conn === "offline" ? t("app.offline") : t("app.reconnecting")}</span>}
      </div>
      <div className="ml-auto flex">
        <button className={btn} aria-label={t("common.minimize")} onClick={() => window.nova?.window.minimize()}>
          <Minus size={15} />
        </button>
        <button className={btn} aria-label={t("common.maximize")} onClick={() => window.nova?.window.maximize()}>
          {max ? <Copy size={12} /> : <Square size={12} />}
        </button>
        <button className={`${btn} hover:!bg-bad hover:!text-white`} aria-label={t("common.close")} onClick={() => window.nova?.window.close()}>
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
