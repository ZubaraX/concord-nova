// Runtime platform detection: Electron desktop (preload bridge), Android app
// (Capacitor), or a plain browser.
import type { ClientPlatform } from "@nova/shared";

type Cap = { getPlatform?: () => string; isNativePlatform?: () => boolean };
const cap = (): Cap | undefined => (window as unknown as { Capacitor?: Cap }).Capacitor;

export const isDesktop = typeof window !== "undefined" && !!window.nova;
export const isAndroid = typeof window !== "undefined" && cap()?.getPlatform?.() === "android";
export const isNative = isDesktop || isAndroid;
export const isMobileUA = typeof navigator !== "undefined" && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
export const isTouch = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
export const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

export const platform: ClientPlatform = isDesktop ? "desktop" : isAndroid || isMobileUA ? "mobile" : "web";

/** Screen share: getDisplayMedia (desktop/browsers) or native capture on Android. */
export const canShareScreen = () => isAndroid || !!navigator.mediaDevices?.getDisplayMedia;

export const modKey = isMac ? "⌘" : "Ctrl";
