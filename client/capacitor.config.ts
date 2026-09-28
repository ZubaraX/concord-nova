import type { CapacitorConfig } from "@capacitor/cli";

// Wraps the built client (dist/) into the Android app. The server address is
// baked in at build time (VITE_API_URL); the native bits live in
// client/android-extras and are wired in by scripts/android-prepare.mjs.
const config: CapacitorConfig = {
  appId: "dev.concord.nova",
  appName: "Concord Nova",
  webDir: "dist",
  backgroundColor: "#0b0d1a",
  server: {
    // https://localhost app origin: a secure context (mic, camera, WebRTC) that
    // matches the TLS server. Cleartext stays allowed for the plain-IP fallback.
    androidScheme: "https",
    cleartext: true,
  },
  android: {
    allowMixedContent: true,
    backgroundColor: "#0b0d1a",
    // The theme opts out of Android 15's forced edge-to-edge instead, so the
    // keyboard still resizes the WebView (adjustResize) and bars stay dark.
    adjustMarginsForEdgeToEdge: "disable",
  },
};

export default config;
