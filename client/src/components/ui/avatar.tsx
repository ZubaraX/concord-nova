import { memo, useState } from "react";
import clsx from "clsx";
import { Smartphone } from "lucide-react";
import type { PresenceStatus } from "@nova/shared";
import { mediaUrl } from "../../lib/server";
import { useData } from "../../store/data";
import { AvatarDecoration } from "./cosmetics";

const PALETTE = ["#6d7cff", "#f0768b", "#3ac3a3", "#f2a541", "#b67cf5", "#4cb4ea", "#e4648f", "#7ccf6e"];

export function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2)).toUpperCase();
}

const STATUS_COLOR: Record<PresenceStatus, string> = {
  online: "bg-ok",
  idle: "bg-warn",
  dnd: "bg-bad",
  offline: "bg-fg-3",
};

/** Shape-coded status dot: dot / moon / bar / ring — readable without color. */
export function StatusDot({ status, size = 12, mobile, className, ring = "ring-panel" }: { status: PresenceStatus; size?: number; mobile?: boolean; className?: string; ring?: string }) {
  if (mobile && status === "online") {
    return (
      <span className={clsx("flex items-center justify-center rounded-[4px] bg-panel text-ok ring-[3px]", ring, className)} style={{ width: size * 0.8, height: size * 1.1 }}>
        <Smartphone size={size} strokeWidth={2.6} />
      </span>
    );
  }
  return (
    <span className={clsx("relative block rounded-full ring-[3px]", ring, STATUS_COLOR[status], className)} style={{ width: size, height: size }}>
      {status === "idle" && <span className="absolute -left-[1px] -top-[1px] rounded-full bg-panel" style={{ width: size * 0.62, height: size * 0.62 }} />}
      {status === "dnd" && <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-panel" style={{ width: size * 0.6, height: size * 0.2 }} />}
      {status === "offline" && <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-panel" style={{ width: size * 0.45, height: size * 0.45 }} />}
    </span>
  );
}

export interface AvatarProps {
  userId?: string;
  src?: string | null;
  name: string;
  size?: number;
  status?: PresenceStatus | null;
  mobile?: boolean;
  className?: string;
  statusRing?: string;
  speaking?: boolean;
  square?: boolean;
}

/** `url` until it fails to load — a missing file then shows the initials, not an empty circle. */
function useImage(url: string | undefined): [string | undefined, () => void] {
  const [failed, setFailed] = useState<string | null>(null);
  return [url && url !== failed ? url : undefined, () => setFailed(url ?? null)];
}

export const Avatar = memo(function Avatar({ userId, src, name, size = 40, status, mobile, className, statusRing, speaking, square }: AvatarProps) {
  const [url, onError] = useImage(mediaUrl(src, size));
  const dot = Math.max(10, Math.round(size * 0.3));
  return (
    <div className={clsx("relative shrink-0", className)} style={{ width: size, height: size }}>
      <div
        className={clsx("h-full w-full overflow-hidden", square ? "rounded-[30%]" : "rounded-full", speaking !== undefined && "aura")}
        data-speaking={speaking === undefined ? undefined : String(!!speaking)}
        style={{ background: url ? undefined : colorFor(userId ?? name) }}
      >
        {url ? (
          <img src={url} alt="" draggable={false} loading="lazy" decoding="async" onError={onError} className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full select-none items-center justify-center font-semibold text-white" style={{ fontSize: Math.max(10, size * 0.38) }}>
            {initials(name)}
          </span>
        )}
      </div>
      {status && (
        <span className="absolute" style={{ right: -2, bottom: -2 }}>
          <StatusDot status={status} mobile={mobile} size={dot} ring={statusRing} />
        </span>
      )}
    </div>
  );
});

/** Avatar bound to live user + presence data. */
export function UserAvatar({ userId, size = 40, showStatus = true, className, statusRing, speaking, decor = true }: { userId: string; size?: number; showStatus?: boolean; className?: string; statusRing?: string; speaking?: boolean; /** Draw the user's avatar decoration. */ decor?: boolean }) {
  const user = useData((s) => s.users[userId]);
  const presence = useData((s) => (showStatus ? s.presences[userId] : undefined));
  const status: PresenceStatus | null = showStatus ? presence?.status ?? "offline" : null;
  const mobile = !!presence && presence.platforms.length === 1 && presence.platforms[0] === "mobile";
  return (
    <div className={clsx("relative shrink-0", className)} style={{ width: size, height: size }}>
      <Avatar userId={userId} src={user?.avatar} name={user?.displayName || user?.username || "?"} size={size} speaking={speaking} />
      {decor && <AvatarDecoration id={user?.decoration} size={size} />}
      {status && (
        <span className="absolute z-[2]" style={{ right: -2, bottom: -2 }}>
          <StatusDot status={status} mobile={mobile} size={Math.max(10, Math.round(size * 0.3))} ring={statusRing} />
        </span>
      )}
    </div>
  );
}

export function GuildIcon({ guildId, name, icon, size = 48, active, className }: { guildId: string; name: string; icon: string | null; size?: number; active?: boolean; className?: string }) {
  const [url, onError] = useImage(mediaUrl(icon, size));
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((w) => w[0])
    .join("");
  return (
    <div
      className={clsx("flex shrink-0 items-center justify-center overflow-hidden transition-[border-radius] duration-200", active ? "rounded-[32%]" : "rounded-[50%] group-hover:rounded-[32%]", className)}
      style={{ width: size, height: size, background: url ? undefined : `linear-gradient(145deg, ${colorFor(guildId)}, rgb(var(--raised)))` }}
    >
      {url ? (
        <img src={url} alt="" draggable={false} onError={onError} className="h-full w-full object-cover" />
      ) : (
        <span className="select-none font-display text-[15px] font-semibold text-white" style={{ fontSize: letters.length > 2 ? size * 0.26 : size * 0.33 }}>
          {letters.toUpperCase() || "?"}
        </span>
      )}
    </div>
  );
}
