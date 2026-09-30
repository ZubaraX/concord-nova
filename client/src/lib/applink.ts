// An invite opened in a browser (a link from another messenger) can continue in
// the installed app: the desktop app registers the concord-nova:// protocol,
// the Android app answers the same scheme through an intent.
const APP_ID = "dev.concord.nova";
const TRIED = "nova.invite.app";

type Win = Window & { nova?: unknown; Capacitor?: { isNativePlatform?: () => boolean } };

/** A regular browser tab (not the desktop app or the Android WebView). */
export function inBrowser(): boolean {
  const w = window as Win;
  return !w.nova && location.protocol !== "app:" && location.protocol !== "file:" && !w.Capacitor?.isNativePlatform?.();
}

const isAndroid = () => /Android/i.test(navigator.userAgent);
const isPhone = () => /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);

/** Hand the invite to the app. `auto`: a silent attempt on page load; otherwise a tap on "Open in app". */
export function openInviteInApp(code: string, auto = false) {
  if (!/^[\w-]+$/.test(code)) return;
  if (isAndroid()) {
    // Browsers only follow intents after a tap. Without the app, stay on this page.
    if (auto) return;
    const back = encodeURIComponent(`${location.origin}/#/invite/${code}`);
    location.href = `intent://invite/${code}#Intent;scheme=concord-nova;package=${APP_ID};S.browser_fallback_url=${back};end`;
    return;
  }
  if (auto && isPhone()) return;
  const url = `concord-nova://invite/${code}`;
  // Chromium asks "Open Concord Nova?" for a top-level navigation and does
  // nothing when the app isn't installed. Other browsers show an error page for
  // an unknown protocol, so there the attempt goes through a hidden frame.
  if ("chrome" in window) {
    location.href = url;
    return;
  }
  const frame = document.createElement("iframe");
  frame.style.display = "none";
  frame.src = url;
  document.body.appendChild(frame);
  setTimeout(() => frame.remove(), 3000);
}

/** Try the app once per tab when an invite link lands in a browser. */
export function autoOpenInvite(code: string) {
  if (!inBrowser()) return;
  try {
    if (sessionStorage.getItem(TRIED) === code) return;
    sessionStorage.setItem(TRIED, code);
  } catch {
    return;
  }
  // After the first paint: a navigation during load can cancel the page itself.
  window.addEventListener("load", () => setTimeout(() => openInviteInApp(code, true), 400), { once: true });
}
