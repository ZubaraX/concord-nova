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

// Web deep link /invite/CODE (served by the SPA fallback) → hash route.
const invite = /^\/invite\/([\w-]+)/.exec(location.pathname);
if (invite) history.replaceState(null, "", `/#/invite/${invite[1]}`);

const root = createRoot(document.getElementById("root")!);
// The desktop "who's speaking" overlay window loads the same bundle with #overlay.
if (location.hash.startsWith("#overlay")) {
  document.documentElement.style.background = "transparent";
  document.body.style.background = "transparent";
  root.render(<Overlay />);
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
