// Music links people bring to the radio: Yandex Music ones become Yandex's own
// player (the widget it offers for sharing — each listener plays it on their
// device, with their own account), and playlist files (.m3u, .pls) give the
// web addresses they list.

const YANDEX_HOST = /^music\.yandex\.(ru|com|by|kz|uz)$/;

/** The official Yandex Music player for a track, album or playlist link; null for anything else. */
export function yandexEmbed(link: string): { src: string; height: number } | null {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (u.protocol !== "https:" || !YANDEX_HOST.test(host)) return null;
  const p = u.pathname.replace(/\/+$/, "");
  let m = p.match(/^\/album\/(\d+)\/track\/(\d+)$/);
  if (m) return { src: `https://${host}/iframe/album/${m[1]}/track/${m[2]}`, height: 244 };
  m = p.match(/^\/album\/(\d+)$/);
  if (m) return { src: `https://${host}/iframe/album/${m[1]}`, height: 450 };
  m = p.match(/^\/users\/([\w.-]+)\/playlists\/(\d+)$/);
  if (m) return { src: `https://${host}/iframe/playlist/${m[1]}/${m[2]}`, height: 450 };
  return null;
}

/**
 * The web addresses a playlist file lists (.m3u/.m3u8 with #EXTINF titles, or
 * .pls), and how many entries point at files on someone's computer instead —
 * those can't be reached from here.
 */
export function parsePlaylist(text: string): { urls: { url: string; title: string | null }[]; local: number } {
  const urls: { url: string; title: string | null }[] = [];
  let local = 0;
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (/^\[playlist\]/i.test(lines.find(Boolean) ?? "")) {
    const files = new Map<string, string>();
    const titles = new Map<string, string>();
    for (const l of lines) {
      const f = l.match(/^File(\d+)=(.+)$/i);
      if (f) files.set(f[1], f[2].trim());
      const t = l.match(/^Title(\d+)=(.+)$/i);
      if (t) titles.set(t[1], t[2].trim());
    }
    for (const [n, f] of files) {
      if (/^https?:\/\//i.test(f)) urls.push({ url: f, title: titles.get(n) ?? null });
      else local++;
    }
    return { urls, local };
  }
  let title: string | null = null;
  for (const l of lines) {
    if (!l) continue;
    const inf = l.match(/^#EXTINF:[^,]*,(.*)$/i);
    if (inf) {
      title = inf[1].trim() || null;
      continue;
    }
    if (l.startsWith("#")) continue;
    if (/^https?:\/\//i.test(l)) urls.push({ url: l, title });
    else local++;
    title = null;
  }
  return { urls, local };
}
