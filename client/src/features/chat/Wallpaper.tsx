// Chat wallpaper: an animated preset or the user's own picture / GIF / video,
// dimmed under the messages so text stays readable.
import { useEffect, useState } from "react";
import { getAsset, onAssetChange } from "../../lib/assets";
import { useSettings } from "../../store/settings";
import { Backdrop } from "../../components/ui/cosmetics";

/** Object URL of the wallpaper file kept on this device (null while loading or when there is none). */
export function useCustomWallpaper(enabled: boolean): { url: string; video: boolean } | null {
  const [file, setFile] = useState<{ url: string; video: boolean } | null>(null);
  useEffect(() => {
    if (!enabled) return setFile(null);
    let url: string | null = null;
    let alive = true;
    const load = () =>
      void getAsset("wallpaper").then((blob) => {
        if (!alive) return;
        if (url) URL.revokeObjectURL(url);
        url = blob ? URL.createObjectURL(blob) : null;
        setFile(url && blob ? { url, video: blob.type.startsWith("video/") } : null);
      });
    load();
    const off = onAssetChange((key) => key === "wallpaper" && load());
    return () => {
      alive = false;
      off();
      if (url) URL.revokeObjectURL(url);
    };
  }, [enabled]);
  return file;
}

export function ChatWallpaper() {
  const kind = useSettings((s) => s.wallpaper);
  const dim = useSettings((s) => s.wallpaperDim);
  const custom = useCustomWallpaper(kind === "custom");
  if (kind === "none" || (kind === "custom" && !custom)) return null;
  return (
    <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden" data-wallpaper={kind} aria-hidden>
      {kind === "custom" && custom ? (
        custom.video ? (
          <video src={custom.url} autoPlay loop muted playsInline className="h-full w-full object-cover" />
        ) : (
          <img src={custom.url} alt="" className="h-full w-full object-cover" />
        )
      ) : (
        <Backdrop kind={kind} />
      )}
      <div className="absolute inset-0 bg-surface" style={{ opacity: Math.max(0, Math.min(90, dim)) / 100 }} />
    </div>
  );
}
