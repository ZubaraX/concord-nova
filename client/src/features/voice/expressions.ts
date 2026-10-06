// Soundboard sounds and voice presets kept on the server: your own (on every
// device you use) and those shared with the servers you're in.
import { create } from "zustand";
import { Permission, type DispatchEvent, type ExpressionsDTO, type SoundDTO, type VoiceParams, type VoicePresetDTO } from "@nova/shared";
import { api, ApiError, uploadImage, uploadSound } from "../../lib/api";
import { deleteAsset, getAsset } from "../../lib/assets";
import { toast } from "../../lib/bus";
import { t } from "../../lib/i18n";
import { can, data, guildPerms } from "../../store/data";
import { setPresetLookup } from "./effects";

interface ExpressionsState {
  sounds: SoundDTO[];
  presets: VoicePresetDTO[];
  loaded: boolean;
  /** false: the server is older than 1.4 and keeps neither. */
  supported: boolean;
}

export const useExpressions = create<ExpressionsState>(() => ({ sounds: [], presets: [], loaded: false, supported: true }));
setPresetLookup((id) => useExpressions.getState().presets.find((p) => p.id === id)?.params ?? null);
const set = (p: Partial<ExpressionsState>) => useExpressions.setState(p);

export async function loadExpressions() {
  try {
    const r = await api<ExpressionsDTO>("/api/expressions");
    set({ sounds: r.sounds, presets: r.presets, loaded: true, supported: true });
    void migrateLocalSounds();
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) set({ loaded: true, supported: false });
  }
}

export function resetExpressions() {
  set({ sounds: [], presets: [], loaded: false, supported: true });
}

const upsert = <T extends { id: string }>(list: T[], item: T) => (list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item]);

export function onExpressionEvent(e: DispatchEvent) {
  const s = useExpressions.getState();
  if (e.t === "SOUND_UPSERT") set({ sounds: upsert(s.sounds, e.d) });
  else if (e.t === "SOUND_DELETE") set({ sounds: s.sounds.filter((x) => x.id !== e.d.id) });
  else if (e.t === "VOICE_PRESET_UPSERT") set({ presets: upsert(s.presets, e.d) });
  else if (e.t === "VOICE_PRESET_DELETE") set({ presets: s.presets.filter((x) => x.id !== e.d.id) });
}

/** Yours (guildId null) plus the given server's — what a call in that server offers. */
export function visibleIn<T extends { ownerId: string; guildId: string | null }>(list: T[], guildId: string | null | undefined, me: string | undefined): { mine: T[]; server: T[] } {
  return { mine: list.filter((x) => !x.guildId && x.ownerId === me), server: guildId ? list.filter((x) => x.guildId === guildId) : [] };
}

/** The author — or, for a server's item, whoever may manage its emoji. */
export function canEdit(item: { ownerId: string; guildId: string | null }): boolean {
  const s = data();
  if (item.ownerId === s.me?.id) return true;
  return !!item.guildId && can(guildPerms(s, item.guildId), Permission.MANAGE_EMOJIS);
}

// ── sounds ───────────────────────────────────────────────────────────────────
export interface SoundDraft {
  name: string;
  emoji: string | null;
  /** A new icon picture; null removes it; undefined keeps it. */
  picture?: Blob | null;
}

async function iconUrl(picture: Blob | null | undefined): Promise<string | null | undefined> {
  if (picture === undefined || picture === null) return picture;
  return (await uploadImage(picture, "sound_icon")).url;
}

export async function addSound(audio: Blob, draft: SoundDraft & { guildId?: string | null; filename?: string }): Promise<SoundDTO> {
  const image = await iconUrl(draft.picture);
  const sound = await uploadSound(audio, draft.filename ?? "sound", {
    name: draft.name.trim().slice(0, 32) || t("soundboard.untitled"),
    emoji: image ? undefined : (draft.emoji ?? "🔊"),
    image: image ?? undefined,
    guildId: draft.guildId ?? undefined,
  });
  set({ sounds: upsert(useExpressions.getState().sounds, sound) });
  return sound;
}

export async function editSound(id: string, draft: SoundDraft): Promise<SoundDTO> {
  const image = await iconUrl(draft.picture);
  const body: Record<string, unknown> = { name: draft.name.trim().slice(0, 32) || t("soundboard.untitled"), emoji: draft.emoji };
  if (image !== undefined) body.image = image;
  const sound = await api<SoundDTO>(`/api/sounds/${id}`, { method: "PATCH", body });
  set({ sounds: upsert(useExpressions.getState().sounds, sound) });
  return sound;
}

export async function removeSound(id: string) {
  await api(`/api/sounds/${id}`, { method: "DELETE" });
  set({ sounds: useExpressions.getState().sounds.filter((x) => x.id !== id) });
}

// ── voice presets ────────────────────────────────────────────────────────────
export async function addPreset(input: { name: string; emoji: string | null; params: VoiceParams; guildId?: string | null }): Promise<VoicePresetDTO> {
  const p = await api<VoicePresetDTO>("/api/voice-presets", { method: "POST", body: { name: input.name.trim().slice(0, 32) || t("voice.fx.untitled"), emoji: input.emoji, params: input.params, ...(input.guildId ? { guildId: input.guildId } : {}) } });
  set({ presets: upsert(useExpressions.getState().presets, p) });
  return p;
}

export async function editPreset(id: string, input: { name: string; emoji: string | null; params: VoiceParams }): Promise<VoicePresetDTO> {
  const p = await api<VoicePresetDTO>(`/api/voice-presets/${id}`, { method: "PATCH", body: { name: input.name.trim().slice(0, 32) || t("voice.fx.untitled"), emoji: input.emoji, params: input.params } });
  set({ presets: upsert(useExpressions.getState().presets, p) });
  return p;
}

export async function removePreset(id: string) {
  await api(`/api/voice-presets/${id}`, { method: "DELETE" });
  set({ presets: useExpressions.getState().presets.filter((x) => x.id !== id) });
}

// ── sounds kept on the device before 1.4 move to the account, once ──────────
const LEGACY_LIST = "nova.soundboard";
let migrating = false;

async function migrateLocalSounds() {
  if (migrating) return;
  let list: { id: string; name: string; emoji: string | null; image: boolean }[] = [];
  try {
    list = JSON.parse(localStorage.getItem(LEGACY_LIST) ?? "[]");
  } catch {
    return;
  }
  if (!Array.isArray(list) || !list.length) return;
  migrating = true;
  let moved = 0;
  try {
    for (const clip of [...list]) {
      const audio = await getAsset(`sound:${clip.id}`);
      if (audio) {
        const picture = clip.image ? ((await getAsset(`soundicon:${clip.id}`)) ?? null) : null;
        try {
          await addSound(audio, { name: clip.name, emoji: clip.emoji, picture });
          moved++;
        } catch (e) {
          // The account is full or the file was refused: keep it here, try again next time.
          if (!(e instanceof ApiError) || e.status === 0 || e.status >= 500) break;
        }
      }
      await deleteAsset(`sound:${clip.id}`).catch(() => {});
      await deleteAsset(`soundicon:${clip.id}`).catch(() => {});
      list = list.filter((c) => c.id !== clip.id);
      localStorage.setItem(LEGACY_LIST, JSON.stringify(list));
    }
    if (!list.length) localStorage.removeItem(LEGACY_LIST);
    if (moved) toast(t("soundboard.migrated", { n: moved }), "success");
  } finally {
    migrating = false;
  }
}
