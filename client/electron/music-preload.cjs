// The music player's page (VK, Yandex Music) inside the desktop app: our volume
// for it. It runs before the site's own scripts, in the site's world, and scales
// what the page plays by the volume the app sends: every audio/video element
// (the page still sees and sets its own volume) and every Web Audio output.

function installVolume() {
  if (window.__novaVolume) return;
  let factor = 1;

  // ── audio / video elements ──
  const media = HTMLMediaElement.prototype;
  const vol = Object.getOwnPropertyDescriptor(media, "volume");
  const own = new WeakMap(); // the volume the page set, per element
  const routed = new WeakSet(); // played through Web Audio: scaled there instead
  const seen = new WeakSet();
  const elements = new Set(); // WeakRefs
  const apply = (el) => vol.set.call(el, routed.has(el) ? (own.get(el) ?? 1) : (own.get(el) ?? 1) * factor);
  const track = (el) => {
    if (!seen.has(el)) {
      seen.add(el);
      elements.add(new WeakRef(el));
    }
    apply(el);
  };
  Object.defineProperty(media, "volume", {
    configurable: true,
    enumerable: true,
    get() {
      return own.get(this) ?? 1;
    },
    set(v) {
      vol.set.call(this, v); // throws on a bad value, as the page expects
      own.set(this, v);
      track(this);
    },
  });
  const play = media.play;
  media.play = function () {
    track(this);
    return play.apply(this, arguments);
  };
  document.addEventListener("play", (e) => e.target instanceof HTMLMediaElement && track(e.target), true);

  // ── Web Audio: whatever reaches the speakers goes through a gain of ours ──
  const outs = new WeakMap(); // context → our gain
  const gains = new Set(); // WeakRefs
  const connect = AudioNode.prototype.connect;
  const disconnect = AudioNode.prototype.disconnect;
  const speakers = (node) => node instanceof AudioDestinationNode && !(node.context instanceof OfflineAudioContext);
  const outFor = (dest) => {
    let g = outs.get(dest.context);
    if (!g) {
      g = dest.context.createGain();
      g.gain.value = factor;
      connect.call(g, dest);
      outs.set(dest.context, g);
      gains.add(new WeakRef(g));
    }
    return g;
  };
  AudioNode.prototype.connect = function (dest, ...rest) {
    return connect.call(this, speakers(dest) ? outFor(dest) : dest, ...rest);
  };
  AudioNode.prototype.disconnect = function (...args) {
    if (speakers(args[0])) args[0] = outs.get(args[0].context) ?? args[0];
    return disconnect.apply(this, args);
  };
  const fromElement = AudioContext.prototype.createMediaElementSource;
  AudioContext.prototype.createMediaElementSource = function (el) {
    routed.add(el);
    track(el);
    return fromElement.call(this, el);
  };

  Object.defineProperty(window, "__novaVolume", {
    value(f) {
      factor = Math.max(0, Math.min(1, Number(f) || 0));
      for (const ref of elements) {
        const el = ref.deref();
        if (el) apply(el);
        else elements.delete(ref);
      }
      for (const ref of gains) {
        const g = ref.deref();
        if (g) g.gain.value = factor;
        else gains.delete(ref);
      }
    },
  });
}

// In the app (outside it — in the tests — this file only defines installVolume).
if (typeof require === "function") {
  const { contextBridge, ipcRenderer } = require("electron");
  contextBridge.executeInMainWorld({ func: installVolume });
  ipcRenderer.on("nova:volume", (_e, v) => contextBridge.executeInMainWorld({ func: (f) => window.__novaVolume?.(f), args: [v] }));
}
