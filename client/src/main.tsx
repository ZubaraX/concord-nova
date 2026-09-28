import "./lib/deeplink"; // first: reads the URL before any other module does
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { applyVisuals } from "./store/settings";
import { Overlay } from "./features/voice/Overlay";

applyVisuals();

if (import.meta.env.DEV) {
  // Dev-only handles for debugging from the console.
  void Promise.all([import("./store/data"), import("./store/messages"), import("./store/ui"), import("./lib/bus")]).then(([d, m, u, b]) => {
    (window as unknown as Record<string, unknown>).__nova = { data: d.useData, messages: m.useMessages, ui: u.useUI, bus: b.bus };
  });
}

const root = createRoot(document.getElementById("root")!);
// The desktop "who's speaking" overlay window loads the same bundle with #overlay.
if (location.hash.startsWith("#overlay")) {
  document.documentElement.style.background = "transparent";
  document.body.style.background = "transparent";
  root.render(<Overlay />);
} else {
  // Desktop: full-window layers (settings, modals, lightbox, calls) start below
  // our own title bar, so the window can always be dragged, minimized, closed.
  if (window.nova) {
    document.documentElement.classList.add("desktop-app");
    document.documentElement.style.setProperty("--chrome-top", "32px");
  }
  root.render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
