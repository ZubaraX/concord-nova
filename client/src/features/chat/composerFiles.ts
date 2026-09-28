// Files staged in a channel's composer. Uploads start immediately (so sending
// is instant once they finish) with progress, cancel and retry.
import { create } from "zustand";
import { ulid, type AttachmentDTO } from "@nova/shared";
import { uploadAttachment, ApiError } from "../../lib/api";
import { errorText } from "../../lib/i18n";
import { isAndroid, isMobileUA } from "../../lib/platform";

export interface Staged {
  id: string;
  file: File;
  preview: string | null;
  progress: number;
  status: "uploading" | "done" | "error";
  attachment?: AttachmentDTO;
  spoiler: boolean;
  error?: string;
  abort: AbortController;
}

export const useStaged = create<{ byChannel: Record<string, Staged[]> }>(() => ({ byChannel: {} }));

function patch(channelId: string, id: string, p: Partial<Staged>) {
  const list = useStaged.getState().byChannel[channelId] ?? [];
  useStaged.setState({ byChannel: { ...useStaged.getState().byChannel, [channelId]: list.map((s) => (s.id === id ? { ...s, ...p } : s)) } });
}

/** Phones: shrink huge photos before upload (saves mobile data, same look in chat). */
async function maybeCompress(file: File): Promise<File> {
  if (!(isAndroid || isMobileUA) || !/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 2.5 * 1024 * 1024) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2560 / Math.max(bmp.width, bmp.height));
    const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.86 });
    return blob.size < file.size ? new File([blob], file.name.replace(/\.\w+$/, ".jpg"), { type: "image/jpeg" }) : file;
  } catch {
    return file;
  }
}

async function upload(channelId: string, s: Staged, query?: Record<string, string | number | undefined>) {
  try {
    const file = await maybeCompress(s.file);
    const att = await uploadAttachment(file, file.name, {
      signal: s.abort.signal,
      query,
      onProgress: (p) => patch(channelId, s.id, { progress: p }),
    });
    patch(channelId, s.id, { status: "done", progress: 1, attachment: att });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") return;
    patch(channelId, s.id, { status: "error", error: errorText(e as ApiError) });
  }
}

export function stageFiles(channelId: string, files: File[]) {
  const cur = useStaged.getState().byChannel[channelId] ?? [];
  const room = Math.max(0, 10 - cur.length);
  const add: Staged[] = files.slice(0, room).map((file) => ({
    id: ulid(),
    file,
    preview: /^image\/|^video\//.test(file.type) ? URL.createObjectURL(file) : null,
    progress: 0,
    status: "uploading",
    spoiler: /^SPOILER_/i.test(file.name),
    abort: new AbortController(),
  }));
  useStaged.setState({ byChannel: { ...useStaged.getState().byChannel, [channelId]: [...cur, ...add] } });
  for (const s of add) void upload(channelId, s);
}

export function retryStaged(channelId: string, id: string) {
  const s = useStaged.getState().byChannel[channelId]?.find((x) => x.id === id);
  if (!s) return;
  const fresh = { ...s, status: "uploading" as const, progress: 0, error: undefined, abort: new AbortController() };
  patch(channelId, id, fresh);
  void upload(channelId, fresh);
}

export function removeStaged(channelId: string, id: string) {
  const list = useStaged.getState().byChannel[channelId] ?? [];
  const s = list.find((x) => x.id === id);
  s?.abort.abort();
  if (s?.preview) URL.revokeObjectURL(s.preview);
  useStaged.setState({ byChannel: { ...useStaged.getState().byChannel, [channelId]: list.filter((x) => x.id !== id) } });
}

export function toggleSpoiler(channelId: string, id: string) {
  const s = useStaged.getState().byChannel[channelId]?.find((x) => x.id === id);
  if (s) patch(channelId, id, { spoiler: !s.spoiler });
}

/** Take finished uploads for sending (clears them from the tray). */
export function takeStaged(channelId: string): { attachments: AttachmentDTO[]; spoilers: string[] } | null {
  const list = useStaged.getState().byChannel[channelId] ?? [];
  if (list.some((s) => s.status === "uploading")) return null;
  const done = list.filter((s) => s.status === "done" && s.attachment);
  for (const s of list) if (s.preview) URL.revokeObjectURL(s.preview);
  useStaged.setState({ byChannel: { ...useStaged.getState().byChannel, [channelId]: [] } });
  return { attachments: done.map((s) => s.attachment!), spoilers: done.filter((s) => s.spoiler).map((s) => s.attachment!.id) };
}

/** Upload a recorded voice message directly (no tray). */
export async function uploadVoice(blob: Blob, duration: number, waveform: string): Promise<AttachmentDTO> {
  const ext = blob.type.includes("ogg") ? "ogg" : blob.type.includes("mp4") ? "m4a" : "webm";
  return uploadAttachment(blob, `voice-message.${ext}`, { query: { voice: "1", duration: duration.toFixed(2), waveform } });
}
