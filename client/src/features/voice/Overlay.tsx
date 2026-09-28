// Desktop in-game overlay (separate transparent always-on-top window that
// loads this bundle with #overlay). Shows who's in the call and who's talking.
import { useEffect, useState } from "react";
import clsx from "clsx";
import { MicOff } from "lucide-react";
import { mediaUrl } from "../../lib/server";
import { colorFor, initials } from "../../components/ui/avatar";

interface OverlayState {
  channel: string;
  people: { id: string; name: string; avatar: string | null; speaking: boolean; muted: boolean }[];
}

export function Overlay() {
  const [state, setState] = useState<OverlayState | null>(null);
  useEffect(() => window.nova?.onOverlayData((s) => setState(s as OverlayState | null)), []);
  if (!state) return null;
  return (
    <div className="flex flex-col gap-1.5 p-2 font-sans">
      {state.people.map((p) => (
        <div key={p.id} className={clsx("flex items-center gap-2 rounded-full py-1 pl-1 pr-3 transition-all", p.speaking ? "bg-black/70" : "bg-black/40")}>
          <div className={clsx("h-7 w-7 shrink-0 overflow-hidden rounded-full ring-2 transition-shadow", p.speaking ? "ring-[#ffc35c] shadow-[0_0_12px_#ffc35c]" : "ring-transparent")} style={{ background: p.avatar ? undefined : colorFor(p.id) }}>
            {p.avatar ? <img src={mediaUrl(p.avatar, 32)} alt="" className="h-full w-full object-cover" /> : <span className="flex h-full items-center justify-center text-[11px] font-bold text-white">{initials(p.name)}</span>}
          </div>
          <span className={clsx("truncate text-[13px] font-semibold", p.speaking ? "text-white" : "text-white/70")}>{p.name}</span>
          {p.muted && <MicOff size={13} className="shrink-0 text-[#ff5c7a]" />}
        </div>
      ))}
    </div>
  );
}
