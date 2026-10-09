// Radio files go from the adder's app to the others through the call (a
// LiveKit byte stream; the server relays, never keeps). Only when a track is
// current or next, so a listener holds two files at most.
//
// Two ways, so a file always gets there:
// - pushed: when a track becomes current or next, its adder sends it to everyone
//   in the call; and to each newcomer once their connection takes data;
// - asked for: a listener who lacks the current or next file asks its adder
//   ("radio-need"), every few seconds until it arrives — this is what covers
//   someone who rejoined, a send lost on the way, a joiner the push missed.
import { create } from "zustand";
import type { ByteStreamReader } from "livekit-client";
import { diag, diagError } from "../../lib/diag";
import { getRoom, useVoice } from "./voice";
import { myFile, useRadio } from "./radio";
import { acceptRadioFile, audioType } from "./radioSync";

export const RADIO_TOPIC = "nova-radio";
const CHUNK = 64 * 1024;
/** How often a missing file is asked for again. */
const ASK_EVERY_MS = 4000;

const received = new Map<string, string>();
/** Files arriving right now (no need to ask for them). */
const receiving = new Set<string>();
export const useRadioFiles = create<{ ready: Record<string, true> }>(() => ({ ready: {} }));
export const radioFileUrl = (itemId: string) => received.get(itemId);

/** Who already got which of my files by the push: item → identities (forgotten when they leave). */
const sent = new Map<string, Set<string>>();
/** Sends under way: "item identity", so an ask and a push don't send the same file twice at once. */
const sending = new Set<string>();
/** When each missing file was last asked for. */
const asked = new Map<string, number>();

/** The current and next tracks of the call I'm in. */
function upcoming() {
  const channelId = useVoice.getState().channelId;
  const st = channelId ? useRadio.getState().states[channelId] : undefined;
  return st?.items.slice(0, 2) ?? [];
}

/**
 * A file from the call. Taken only if it belongs to the current or next track and
 * comes from whoever added that track; anything else (another member's file under
 * someone's track id, or one sent before this app had the queue) is dropped — the
 * real one is asked for again (askForMissing).
 */
export async function onRadioStream(reader: ByteStreamReader, from: string) {
  const itemId = reader.info.attributes?.itemId;
  if (!itemId || received.has(itemId) || receiving.has(itemId)) return;
  if (!acceptRadioFile(upcoming(), itemId, from, reader.info.size)) {
    diag("radio", "file refused", { item: itemId, from, size: reader.info.size });
    return;
  }
  receiving.add(itemId);
  try {
    const chunks = await reader.readAll();
    received.set(itemId, URL.createObjectURL(new Blob(chunks as BlobPart[], { type: audioType(reader.info.mimeType) })));
    useRadioFiles.setState((s) => ({ ready: { ...s.ready, [itemId]: true } }));
    diag("radio", "file received", { item: itemId, size: reader.info.size });
  } catch (e) {
    diagError("radio", e, { step: "receive", item: itemId });
  } finally {
    receiving.delete(itemId);
  }
}

async function sendTo(itemId: string, file: File, to: string[]) {
  const room = getRoom();
  const fresh = to.filter((id) => !sending.has(`${itemId} ${id}`));
  if (!room || !fresh.length) return false;
  fresh.forEach((id) => sending.add(`${itemId} ${id}`));
  try {
    const writer = await room.localParticipant.streamBytes({ topic: RADIO_TOPIC, name: file.name, mimeType: file.type || "audio/mpeg", totalSize: file.size, attributes: { itemId }, destinationIdentities: fresh });
    for (let at = 0; at < file.size; at += CHUNK) await writer.write(new Uint8Array(await file.slice(at, at + CHUNK).arrayBuffer()));
    await writer.close();
    diag("radio", "file sent", { item: itemId, to: fresh.length, size: file.size });
    return true;
  } catch (e) {
    diagError("radio", e, { step: "send", item: itemId });
    return false;
  } finally {
    fresh.forEach((id) => sending.delete(`${itemId} ${id}`));
  }
}

/** Pushes my current/next files to whoever in the call hasn't had them (or just to a newcomer). */
export async function sendRadioFiles(newcomer?: string) {
  const room = getRoom();
  if (!room) return;
  for (const item of upcoming()) {
    const file = item.kind === "file" ? myFile(item.id) : undefined;
    if (!file) continue;
    const got = sent.get(item.id) ?? new Set<string>();
    sent.set(item.id, got);
    const to = (newcomer ? [newcomer] : [...room.remoteParticipants.keys()]).filter((id) => !got.has(id));
    if (!to.length) continue;
    to.forEach((id) => got.add(id));
    if (!(await sendTo(item.id, file, to))) to.forEach((id) => got.delete(id));
  }
}

/** Someone asked for a file of mine they lack: send it to them, whatever the push thinks. */
export function onRadioNeed(from: string, itemId: string) {
  const file = myFile(itemId);
  if (!file || !upcoming().some((i) => i.id === itemId)) return;
  diag("radio", "file asked for", { item: itemId, by: from });
  void sendTo(itemId, file, [from]);
}

/** Asks the adders for the current/next files I lack. */
export function askForMissing() {
  const room = getRoom();
  if (!room) return;
  const now = Date.now();
  for (const item of upcoming()) {
    if (item.kind !== "file" || myFile(item.id) || received.has(item.id) || receiving.has(item.id)) continue;
    if (!room.remoteParticipants.has(item.addedBy) || now - (asked.get(item.id) ?? 0) < ASK_EVERY_MS) continue;
    asked.set(item.id, now);
    void room.localParticipant
      .publishData(new TextEncoder().encode(JSON.stringify({ t: "radio-need", itemId: item.id })), { reliable: true, destinationIdentities: [item.addedBy] })
      .catch(() => {});
  }
}
setInterval(askForMissing, ASK_EVERY_MS);

/** Someone left the call: if they come back, the push sends them the files again. */
export function forgetParticipant(identity: string) {
  for (const got of sent.values()) got.delete(identity);
}

/**
 * Received files of tracks that are gone are released — gone from the queue as
 * we know it: a file can arrive before this app has the queue at all (joining).
 */
useRadio.subscribe((s) => {
  const channelId = useVoice.getState().channelId;
  const st = channelId ? s.states[channelId] : undefined;
  if (!st) return;
  const live = new Set(st.items.map((i) => i.id));
  let changed = false;
  for (const [id, url] of [...received]) if (!live.has(id)) (URL.revokeObjectURL(url), received.delete(id), (changed = true));
  for (const id of [...sent.keys()]) if (!live.has(id)) sent.delete(id);
  for (const id of [...asked.keys()]) if (!live.has(id)) asked.delete(id);
  if (changed) useRadioFiles.setState({ ready: Object.fromEntries([...received.keys()].map((k) => [k, true as const])) });
  void sendRadioFiles();
  askForMissing();
});

export function clearRadioFiles() {
  for (const url of received.values()) URL.revokeObjectURL(url);
  received.clear();
  receiving.clear();
  sent.clear();
  asked.clear();
  useRadioFiles.setState({ ready: {} });
}
