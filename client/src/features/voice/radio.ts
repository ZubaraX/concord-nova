// The radio, on this side: each channel's state from the server, the clock
// offset to play in step with it, and what people do with it. The files you add
// stay on your device (`mine`) until the call needs them (./radioFiles).
import { create } from "zustand";
import { RADIO_MAX_FILE_BYTES, RADIO_MAX_SECONDS, isMusicServiceLink, type RadioItemDTO, type RadioStateDTO } from "@nova/shared";
import { api } from "../../lib/api";
import { bus, toast } from "../../lib/bus";
import { diag } from "../../lib/diag";
import { errorText, t } from "../../lib/i18n";
import { data } from "../../store/data";
import { goneIds, isNewer, titleOf } from "./radioSync";
import { parsePlaylist } from "./musicLinks";

interface RadioStore {
  states: Record<string, RadioStateDTO>;
  /** Server clock − this one, ms. */
  offset: number;
  /** Bumped when a file of yours joins: the server's update often arrives before the add returns, and the file must still go out. */
  mineRev: number;
}
export const useRadio = create<RadioStore>(() => ({ states: {}, offset: 0, mineRev: 0 }));

/** Offsets seen recently: delays only make one look smaller, so the largest is the truest. */
const seen: { at: number; v: number }[] = [];
function learn(serverNow: number) {
  const now = Date.now();
  seen.push({ at: now, v: serverNow - now });
  while (seen.length && now - seen[0].at > 60_000) seen.shift();
  useRadio.setState({ offset: Math.max(...seen.map((s) => s.v)) });
}
export const serverNow = () => Date.now() + useRadio.getState().offset;

function put(s: RadioStateDTO) {
  learn(s.serverNow);
  useRadio.setState((r) => (isNewer(r.states[s.channelId], s) ? { states: { ...r.states, [s.channelId]: s } } : r));
}
bus.on("dispatch", (e) => {
  if (e.t === "RADIO_STATE") put(e.d);
  // On every (re)connect: the radio of each channel with people in it, afresh — the sidebar line
  // after the app opens, and no ghost queue after the server restarted (a deploy).
  if (e.t === "READY") for (const id of new Set(Object.values(data().voiceStates).map((v) => v.channelId))) if (id) void loadRadio(id);
});

export async function loadRadio(channelId: string) {
  await api<RadioStateDTO>(`/api/channels/${channelId}/radio`).then(put, () => {});
}

const mine = new Map<string, File>();
/** A file you added (to play yourself and to send to the others). */
export const myFile = (itemId: string) => mine.get(itemId);

/** A track's length for the server, to a tenth of a second (rounded up whole, it left a gap after each track). */
const seconds = (d: number) => Math.max(1, Math.round(d * 10) / 10);

/** How long a file or link plays, by asking an audio element; null if it isn't playable audio. */
function probe(src: string): Promise<number | null> {
  return new Promise((resolve) => {
    const a = new Audio();
    a.preload = "metadata";
    const done = (v: number | null) => {
      clearTimeout(timer);
      a.removeAttribute("src");
      a.load();
      resolve(v);
    };
    const timer = setTimeout(() => done(null), 12_000);
    a.onloadedmetadata = () => done(Number.isFinite(a.duration) && a.duration > 0 ? a.duration : null);
    a.onerror = () => done(null);
    a.src = src;
  });
}


const PLAYLIST = /\.(m3u8?|pls)$/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|flac|wav|weba|webm)$/i;
const isAudio = (f: File) => f.type.startsWith("audio/") || AUDIO_EXT.test(f.name);

/** A whole folder: its audio files, in name order (a folder of music is a playlist too). */
export function addFolder(channelId: string, files: File[]) {
  const audio = files.filter(isAudio).sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, undefined, { numeric: true }));
  return addFiles(channelId, audio);
}

/** A playlist file (.m3u, .pls): the web addresses it lists join the queue. Entries on someone's computer can't be reached. */
async function addPlaylistFile(channelId: string, file: File) {
  const { urls, local } = parsePlaylist(await file.text());
  if (local) toast(t("radio.playlistLocal", { n: local }));
  for (const u of urls) await addLink(channelId, u.url, u.title ?? undefined);
}

export async function addFiles(channelId: string, files: File[]) {
  for (const file of files) {
    if (PLAYLIST.test(file.name)) {
      await addPlaylistFile(channelId, file);
      continue;
    }
    if (file.size > RADIO_MAX_FILE_BYTES) {
      toast(t("radio.tooBig", { name: file.name }), "error");
      continue;
    }
    const url = URL.createObjectURL(file);
    const duration = await probe(url);
    URL.revokeObjectURL(url);
    if (!duration) {
      toast(t("radio.notAudio", { name: file.name }), "error");
      continue;
    }
    if (duration > RADIO_MAX_SECONDS) {
      toast(t("radio.tooLong", { name: file.name }), "error");
      continue;
    }
    try {
      const item = await api<RadioItemDTO>(`/api/channels/${channelId}/radio/items`, { method: "POST", body: { kind: "file", title: titleOf(file.name), duration: seconds(duration) } });
      mine.set(item.id, file);
      useRadio.setState((s) => ({ mineRev: s.mineRev + 1 }));
      diag("radio", "added file", { item: item.id, size: file.size, duration: seconds(duration) });
    } catch (e) {
      toast(errorText(e), "error");
    }
  }
}

export async function addLink(channelId: string, raw: string, title?: string) {
  const url = raw.trim();
  if (!/^https?:\/\//i.test(url)) return toast(t("radio.badLink"), "error");
  try {
    if (isMusicServiceLink(url)) {
      await api(`/api/channels/${channelId}/radio/links`, { method: "POST", body: { url } });
      return;
    }
    const duration = await probe(url);
    if (!duration) return toast(t("radio.linkNotAudio"), "error");
    if (duration > RADIO_MAX_SECONDS) return toast(t("radio.tooLong", { name: url }), "error");
    const name = new URL(url).pathname.split("/").filter(Boolean).pop() ?? url;
    await api(`/api/channels/${channelId}/radio/items`, { method: "POST", body: { kind: "link", url, title: title?.trim().slice(0, 200) || titleOf(name, true), duration: seconds(duration) } });
  } catch (e) {
    toast(errorText(e), "error");
  }
}

const act = (p: Promise<unknown>) => p.catch((e) => toast(errorText(e), "error"));
export const removeItem = (channelId: string, itemId: string) => act(api(`/api/channels/${channelId}/radio/items/${itemId}`, { method: "DELETE" }));
export const skip = (channelId: string) => {
  const id = useRadio.getState().states[channelId]?.current?.itemId;
  if (id) void act(api(`/api/channels/${channelId}/radio/skip`, { method: "POST", body: { itemId: id } }));
};
/** Back: near a track's start the one before it, further in this one from its start (the server decides). */
export const previous = (channelId: string) => {
  const id = useRadio.getState().states[channelId]?.current?.itemId ?? null;
  void act(api(`/api/channels/${channelId}/radio/previous`, { method: "POST", body: { itemId: id } }));
};
export const playNow = (channelId: string, itemId: string) => act(api(`/api/channels/${channelId}/radio/items/${itemId}/play`, { method: "POST" }));
export const pause = (channelId: string) => act(api(`/api/channels/${channelId}/radio/pause`, { method: "POST" }));
export const resume = (channelId: string) => act(api(`/api/channels/${channelId}/radio/resume`, { method: "POST" }));

/**
 * Files of yours whose tracks left the queue and the history (played ones are kept to go
 * back to) can go — not before: the add's answer can come before the server's update.
 */
const seenMine = new Set<string>();
useRadio.subscribe((s) => {
  const live = new Set(Object.values(s.states).flatMap((st) => [...st.items, ...(st.history ?? [])].map((i) => i.id)));
  for (const id of goneIds([...mine.keys()], seenMine, live)) mine.delete(id);
});
