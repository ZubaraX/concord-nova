// Plays the call's radio here: the current track from its link, the file you
// added, or the file the adder sent — at the position the server's clock says,
// at your own volume.
import { settings, useSettings } from "../../store/settings";
import { mediaUrl } from "../../lib/server";
import { myFile, serverNow, useRadio } from "./radio";
import { radioFileUrl, useRadioFiles } from "./radioFiles";
import { shouldPlay, shouldSeek, sourceStep } from "./radioSync";
import { useVoice } from "./voice";

const el = new Audio();
el.preload = "auto";
// In the page (hidden), so it can be found — the tests read it as it is.
el.dataset.radioPlayer = "";
el.style.display = "none";
document.body.appendChild(el);
let srcFor: string | null = null;
/** The track the first seek was made for (later ones wait for data, so a slow link isn't sought over and over). */
let seekedFor: string | null = null;
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
  const station = st?.station;
  // An FM station plays instead of the queue, at your FM volume.
  const own = station ? (s.fmVolume ?? 60) : (s.radioVolume ?? 60);
  el.volume = v.deafened ? 0 : Math.max(0, Math.min(1, (own / 100) * Math.min(1, (s.outputVolume ?? 100) / 100)));
  const sink = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  if (sink.setSinkId && s.outputDevice && (sink as { sinkId?: string }).sinkId !== s.outputDevice) void sink.setSinkId(s.outputDevice).catch(() => {});
  if (station) {
    // Live: no position to keep — load it (again, if another station came) and play.
    const play = mediaUrl(station.play) ?? station.play;
    if (srcFor !== "station" || el.dataset.station !== play) {
      srcFor = "station";
      seekedFor = null;
      el.dataset.item = "station";
      el.dataset.station = play;
      el.src = play;
    }
    if (el.paused) void el.play().catch(() => {});
    return;
  }
  if (srcFor === "station") unload();
  if (!cur || !item) return void (srcFor && unload());
  const src = sourceFor(item.id, item.kind, item.url);
  const step = sourceStep(srcFor, item.id, src);
  // The next track's file hasn't come: the skipped one mustn't play on meanwhile.
  if (step === "stop") return unload();
  if (step === "wait") return; // the file is on its way
  if (step === "switch") {
    srcFor = item.id;
    seekedFor = null;
    el.dataset.item = item.id;
    el.src = src!;
  }
  const target = (cur.pausedAt ?? serverNow() - cur.startedAt) / 1000;
  if (shouldSeek(el, target, seekedFor !== item.id)) {
    el.currentTime = target;
    seekedFor = item.id;
  }
  if (cur.pausedAt !== null || !shouldPlay(el, target, item.duration)) el.pause();
  else if (el.paused) void el.play().catch(() => {});
}

function unload() {
  el.pause();
  el.removeAttribute("src");
  el.load();
  srcFor = null;
  seekedFor = null;
  delete el.dataset.item;
  delete el.dataset.station;
}

el.addEventListener("loadedmetadata", sync);
useRadio.subscribe(sync);
useRadioFiles.subscribe(sync);
useVoice.subscribe((s, p) => {
  if (s.state !== p.state || s.channelId !== p.channelId || s.deafened !== p.deafened) sync();
});
useSettings.subscribe((s, p) => {
  if (s.radioVolume !== p.radioVolume || s.fmVolume !== p.fmVolume || s.outputVolume !== p.outputVolume || s.outputDevice !== p.outputDevice) sync();
});
setInterval(sync, 1000);
sync();

export function radioPlayerState() {
  return { itemId: srcFor, src: el.currentSrc || null, time: el.currentTime, volume: el.volume, paused: el.paused };
}
