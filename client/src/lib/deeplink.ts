// Web deep links, captured before any other app module reads the URL (main.tsx
// imports this first). /invite/CODE (served by the SPA fallback) and
// #/invite/CODE are remembered for the tab: the sign-up screen shows the
// invite, and after logging in the "accept invite" dialog opens.
import { autoOpenInvite } from "./applink";

const KEY = "nova.invite";

const m = /^\/invite\/([\w-]+)/.exec(location.pathname) ?? /^#\/invite\/([\w-]+)/.exec(location.hash);
if (m) {
  try {
    sessionStorage.setItem(KEY, m[1]);
  } catch {
    /* private mode */
  }
  const base = location.pathname.startsWith("/invite/") ? "/" : location.pathname;
  history.replaceState(null, "", `${base}#/channels/@me`);
  // In a browser: offer the installed app first (the page still works without it).
  autoOpenInvite(m[1]);
}

export function pendingInvite(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function clearPendingInvite() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
