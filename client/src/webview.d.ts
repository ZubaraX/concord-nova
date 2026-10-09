// Electron's <webview> — the desktop app's music player (see MusicDock.tsx).
// React's types know the tag; these are the element's methods.
interface HTMLWebViewElement {
  send(channel: string, ...args: unknown[]): void;
  canGoBack(): boolean;
  goBack(): void;
  loadURL(url: string): Promise<void>;
  setZoomFactor(factor: number): void;
}
