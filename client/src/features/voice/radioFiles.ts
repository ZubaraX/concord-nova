// Radio files go from the adder's app to the others through the call (a
// LiveKit byte stream; the server relays, never keeps). Only when a track is
// current or next, so a listener holds two files at most; newcomers get them
// when they join.
import { create } from "zustand";
import type { ByteStreamReader } from "livekit-client";
import { diag, diagError } from "../../lib/diag";
import { getRoom, useVoice } from "./voice";
import { myFile, useRadio } from "./radio";

export const RADIO_TOPIC = "nova-radio";
const CHUNK = 64 * 1024;

const received = new Map<string, string>();
export const useRadioFiles = create<{ ready: Record<string, true> }>(() => ({ ready: {} }));
export const radioFileUrl = (itemId: string) => received.get(itemId);

/** Who already got which of my files: item → identities. */
const sent = new Map<string, Set<string>>();

export async function onRadioStream(reader: ByteStreamReader) {
  const itemId = reader.info.attributes?.itemId;
  if (!itemId || received.has(itemId)) return;
  try {
    const chunks = await reader.readAll();
    received.set(itemId, URL.createObjectURL(new Blob(chunks as BlobPart[], { type: reader.info.mimeType || "audio/mpeg" })));
    useRadioFiles.setState((s) => ({ ready: { ...s.ready, [itemId]: true } }));
    diag("radio", "file received", { item: itemId, size: reader.info.size });
  } catch (e) {
    diagError("radio", e, { step: "receive", item: itemId });
  }
}

/** Sends my current/next files to whoever in the call hasn't got them (or just to a newcomer). */
export async function sendRadioFiles(newcomer?: string) {
  const room = getRoom();
  const channelId = useVoice.getState().channelId;
  if (!room || !channelId) return;
  const st = useRadio.getState().states[channelId];
  for (const item of st?.items.slice(0, 2) ?? []) {
    const file = item.kind === "file" ? myFile(item.id) : undefined;
    if (!file) continue;
    const got = sent.get(item.id) ?? new Set<string>();
    sent.set(item.id, got);
    const to = (newcomer ? [newcomer] : [...room.remoteParticipants.keys()]).filter((id) => !got.has(id));
    if (!to.length) continue;
    to.forEach((id) => got.add(id));
    try {
      const writer = await room.localParticipant.streamBytes({ topic: RADIO_TOPIC, name: file.name, mimeType: file.type || "audio/mpeg", totalSize: file.size, attributes: { itemId: item.id }, destinationIdentities: to });
      for (let at = 0; at < file.size; at += CHUNK) await writer.write(new Uint8Array(await file.slice(at, at + CHUNK).arrayBuffer()));
      await writer.close();
      diag("radio", "file sent", { item: item.id, to: to.length, size: file.size });
    } catch (e) {
      to.forEach((id) => got.delete(id));
      diagError("radio", e, { step: "send", item: item.id });
    }
  }
}

/** Received files of tracks that are gone are released. */
useRadio.subscribe((s) => {
  const live = new Set(Object.values(s.states).flatMap((st) => st.items.map((i) => i.id)));
  let changed = false;
  for (const [id, url] of [...received]) if (!live.has(id)) (URL.revokeObjectURL(url), received.delete(id), (changed = true));
  for (const id of [...sent.keys()]) if (!live.has(id)) sent.delete(id);
  if (changed) useRadioFiles.setState({ ready: Object.fromEntries([...received.keys()].map((k) => [k, true as const])) });
  void sendRadioFiles();
});

export function clearRadioFiles() {
  for (const url of received.values()) URL.revokeObjectURL(url);
  received.clear();
  sent.clear();
  useRadioFiles.setState({ ready: {} });
}
