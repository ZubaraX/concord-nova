/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
/** Id of this web build (null in dev) — see vite.config.ts. */
declare const __NOVA_BUILD__: string | null;
/** CI run number of this build (0 for local builds). */
declare const __APP_BUILD__: number;

interface ImportMetaEnv {
  /** Server base URL baked into desktop/Android builds (e.g. https://chat.example.com). */
  readonly VITE_API_URL?: string;
  /** Optional fallback base for networks that can't reach the primary. */
  readonly VITE_API_URL_FALLBACK?: string;
  /** Android: android-latest.json of the published APK (update prompt). */
  readonly VITE_ANDROID_UPDATE_URL?: string;
}

/** Bridge exposed by the Electron preload script (desktop app only). */
interface NovaDesktop {
  platform: string;
  version: string;
  getSources(): Promise<{ id: string; name: string; thumbnail: string; appIcon: string | null; isScreen: boolean }[]>;
  selectSource(id: string | null, withAudio: boolean): void;
  /** Main process asks the renderer to show the screen picker. */
  onScreenPick(cb: () => void): () => void;
  /** Screen-share audio captured without Nova itself (Windows): start, 48 kHz stereo 16-bit PCM chunks, end. Absent in older shells. */
  onAppAudio?(cb: (kind: "start" | "pcm" | "end", pcm?: Uint8Array) => void): () => void;
  stopAppAudio?(): void;
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
  /** The music window (VK / Yandex Music sites, its own signed-in session). */
  openMusic?(url: string): void;
  setAutoLaunch?(on: boolean): void;
}

interface Window {
  nova?: NovaDesktop;
}
