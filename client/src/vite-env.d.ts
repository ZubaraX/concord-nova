/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** Server base URL baked into desktop/Android builds (e.g. https://chat.example.com). */
  readonly VITE_API_URL?: string;
  /** Optional fallback base for networks that can't reach the primary. */
  readonly VITE_API_URL_FALLBACK?: string;
}

/** Bridge exposed by the Electron preload script (desktop app only). */
interface NovaDesktop {
  platform: string;
  version: string;
  getSources(): Promise<{ id: string; name: string; thumbnail: string; appIcon: string | null; isScreen: boolean }[]>;
  selectSource(id: string | null, withAudio: boolean): void;
  /** Main process asks the renderer to show the screen picker. */
  onScreenPick(cb: () => void): () => void;
  setCloseToTray(on: boolean): void;
  setBadge(count: number, dataUrl: string | null): void;
  flashFrame(on: boolean): void;
  notify(title: string, body: string, tag?: string): void;
  onNotificationClick(cb: (tag: string) => void): () => void;
  window: { minimize(): void; maximize(): void; close(): void; isMaximized(): boolean; onMaximizeChange(cb: (v: boolean) => void): () => void };
  onUpdate(cb: (s: { state: string; version?: string; percent?: number }) => void): () => void;
  installUpdate(): void;
  onActivity(cb: (game: string | null) => void): () => void;
  setGlobalShortcuts(map: Record<string, string | null>): void;
  onGlobalShortcut(cb: (action: string) => void): () => void;
  onPttChange?(cb: (down: boolean) => void): () => void;
  setOverlay(state: unknown): void;
  onOverlayData(cb: (state: unknown) => void): () => void;
  openExternal(url: string): void;
  setAutoLaunch?(on: boolean): void;
}

interface Window {
  nova?: NovaDesktop;
}
