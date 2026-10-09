// Plays the call's radio here: the current track from its link, the file you
// added, or the file the adder sent — at the position the server's clock says,
// at your own volume.
import { settings, useSettings } from "../../store/settings";
import { myFile, serverNow, useRadio } from "./radio";
import { radioFileUrl, useRadioFiles } from "./radioFiles";
import { useVoice } from "./voice";

const el = new Audio();
el.preload = "auto";
// In the page (hidden), so it can be found — the tests read it as it is.
el.dataset.radioPlayer = "";
el.style.display = "none";
document.body.appendChild(el);
let srcFor: string | null = null;
let ownUrl: string | null = null;

function sourceFor(itemId: string, kind: "file" | "link", url: string | null): string | undefined {
  if (kind === "link") return url ?? undefined;
  const mine = myFile(itemId);
  if (mine) {
    if (srcFor !== itemId || !ownUrl) {
      if (ownUrl) URL.revokeObjectURL(ownUrl);
      ownUrl = URL.createObjectURL(mine);
    }
    return ownUrl;
  }
  return radioFileUrl(itemId);
}

function sync() {
  const v = useVoice.getState();
  const s = settings();
  const st = v.state === "connected" && v.channelId ? useRadio.getState().states[v.channelId] : undefined;
  const cur = st?.current;
  const item = cur ? st!.items[0] : undefined;
  el.volume = v.deafened ? 0 : Math.max(0, Math.min(1, ((s.radioVolume ?? 60) / 100) * Math.min(1, (s.outputVolume ?? 100) / 100)));
  const sink = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  if (sink.setSinkId && s.outputDevice && (sink as { sinkId?: string }).sinkId !== s.outputDevice) void sink.setSinkId(s.outputDevice).catch(() => {});
  if (!cur || !item) {
    if (srcFor) {
      el.pause();
      el.removeAttribute("src");
      el.load();
      srcFor = null;
      delete el.dataset.item;
    }
    return;
  }
  const src = sourceFor(item.id, item.kind, item.url);
  if (!src) return; // the file is on its way
  if (srcFor !== item.id) {
    srcFor = item.id;
    el.dataset.item = item.id;
    el.src = src;
  }
  const target = (cur.pausedAt ?? serverNow() - cur.startedAt) / 1000;
  if (target >= item.duration) return void el.pause();
  if (Math.abs(el.currentTime - target) > 0.3 && el.readyState >= 1) el.currentTime = target;
  if (cur.pausedAt !== null) el.pause();
  else if (el.paused) void el.play().catch(() => {});
}

el.addEventListener("loadedmetadata", sync);
useRadio.subscribe(sync);
useRadioFiles.subscribe(sync);
useVoice.subscribe((s, p) => {
  if (s.state !== p.state || s.channelId !== p.channelId || s.deafened !== p.deafened) sync();
});
useSettings.subscribe((s, p) => {
  if (s.radioVolume !== p.radioVolume || s.outputVolume !== p.outputVolume || s.outputDevice !== p.outputDevice) sync();
});
setInterval(sync, 1000);
sync();

export function radioPlayerState() {
  return { itemId: srcFor, src: el.currentSrc || null, time: el.currentTime, volume: el.volume, paused: el.paused };
}
