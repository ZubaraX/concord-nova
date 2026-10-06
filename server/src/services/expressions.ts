// Soundboard sounds and voice presets. Each is either the owner's own — on
// every device they sign in on — or shared with a server, where every member
// can use it. Any member may share; the author (or whoever may manage the
// server's emoji) can change or remove it.
import { unlink } from "node:fs/promises";
import type { Readable } from "node:stream";
import { MAX_GUILD_PRESETS, MAX_GUILD_SOUNDS, MAX_OWN_PRESETS, MAX_OWN_SOUNDS, MAX_SOUND_BYTES, Permission, ulid, type ExpressionsDTO, type SoundDTO, type VoiceParams, type VoicePresetDTO } from "@nova/shared";
import { prisma, jsonParse } from "../db";
import { ApiError, badRequest, forbidden, notFound } from "../lib/errors";
import { deleteStored, newRelPath, publicUrl, resolveStorage, saveStream, sniffFile } from "../lib/files";
import { cache } from "../state/cache";
import { toGuild, toUser } from "../gateway/io";

interface SoundRow {
  id: string;
  ownerId: string;
  guildId: string | null;
  name: string;
  emoji: string | null;
  image: string | null;
  path: string;
  createdAt: Date;
}
interface PresetRow {
  id: string;
  ownerId: string;
  guildId: string | null;
  name: string;
  emoji: string | null;
  params: string;
  createdAt: Date;
}

const toSound = (r: SoundRow): SoundDTO => ({ id: r.id, ownerId: r.ownerId, guildId: r.guildId, name: r.name, emoji: r.emoji, image: r.image, url: publicUrl(r.path), createdAt: r.createdAt.toISOString() });
const toPreset = (r: PresetRow): VoicePresetDTO => ({ id: r.id, ownerId: r.ownerId, guildId: r.guildId, name: r.name, emoji: r.emoji, params: jsonParse<VoiceParams>(r.params, {} as VoiceParams), createdAt: r.createdAt.toISOString() });

/** Who hears about a change: the server's members, or just the owner. */
function announce<K extends "SOUND_UPSERT" | "SOUND_DELETE" | "VOICE_PRESET_UPSERT" | "VOICE_PRESET_DELETE">(row: { ownerId: string; guildId: string | null }, t: K, d: Parameters<typeof toUser<K>>[2]) {
  if (row.guildId) toGuild(row.guildId, t, d);
  else toUser(row.ownerId, t, d);
}

function requireShareable(userId: string, guildId: string | undefined) {
  if (guildId && !cache.isMember(guildId, userId)) throw notFound("unknown_guild");
}

/** The author, or someone who may manage the server's emoji. */
function requireEditor(userId: string, row: { ownerId: string; guildId: string | null }) {
  if (row.ownerId === userId) return;
  if (row.guildId && cache.hasGuildPerm(row.guildId, userId, Permission.MANAGE_EMOJIS)) return;
  throw forbidden("missing_permissions");
}

export async function listExpressions(userId: string): Promise<ExpressionsDTO> {
  const guilds = cache.userGuildIds(userId);
  const where = { OR: [{ ownerId: userId, guildId: null }, ...(guilds.length ? [{ guildId: { in: guilds } }] : [])] };
  const [sounds, presets] = await Promise.all([prisma.sound.findMany({ where, orderBy: { createdAt: "asc" } }), prisma.voicePreset.findMany({ where, orderBy: { createdAt: "asc" } })]);
  return { sounds: sounds.map(toSound), presets: presets.map(toPreset) };
}

// ── sounds ───────────────────────────────────────────────────────────────────
const AUDIO_EXT: Record<string, string> = { "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/wav": "wav", "audio/mp4": "m4a", "audio/flac": "flac", "video/webm": "webm", "video/mp4": "m4a" };

async function countSounds(userId: string, guildId: string | undefined) {
  return guildId ? prisma.sound.count({ where: { guildId } }) : prisma.sound.count({ where: { ownerId: userId, guildId: null } });
}

export async function createSound(userId: string, file: Readable & { truncated?: boolean }, meta: { name: string; emoji?: string | null; image?: string | null; guildId?: string }): Promise<SoundDTO> {
  requireShareable(userId, meta.guildId);
  if ((await countSounds(userId, meta.guildId)) >= (meta.guildId ? MAX_GUILD_SOUNDS : MAX_OWN_SOUNDS)) throw badRequest("sound_limit");
  let rel = newRelPath("sound.bin");
  await saveStream(file, rel, MAX_SOUND_BYTES);
  if (file.truncated) {
    await deleteStored(rel);
    throw new ApiError(413, "file_too_large");
  }
  const type = await sniffFile(resolveStorage(rel));
  const ext = type ? AUDIO_EXT[type] : undefined;
  if (!ext) {
    await deleteStored(rel);
    throw badRequest("invalid_audio");
  }
  // The extension decides the Content-Type the file is served with.
  const named = rel.replace(/sound\.bin$/, `sound.${ext}`);
  const { rename } = await import("node:fs/promises");
  await rename(resolveStorage(rel), resolveStorage(named));
  rel = named;
  const row = await prisma.sound.create({
    data: { id: ulid(), ownerId: userId, guildId: meta.guildId ?? null, name: meta.name, emoji: meta.image ? null : (meta.emoji ?? null), image: meta.image ?? null, path: rel },
  });
  const dto = toSound(row);
  announce(row, "SOUND_UPSERT", dto);
  return dto;
}

export async function updateSound(userId: string, id: string, patch: { name?: string; emoji?: string | null; image?: string | null }): Promise<SoundDTO> {
  const row = await prisma.sound.findUnique({ where: { id } });
  if (!row) throw notFound("unknown_sound");
  requireEditor(userId, row);
  const image = patch.image !== undefined ? patch.image : row.image;
  const updated = await prisma.sound.update({
    where: { id },
    data: { name: patch.name ?? row.name, image, emoji: image ? null : patch.emoji !== undefined ? patch.emoji : row.emoji },
  });
  if (row.image && row.image !== updated.image) await removeImage(row.image);
  const dto = toSound(updated);
  announce(updated, "SOUND_UPSERT", dto);
  return dto;
}

export async function deleteSound(userId: string, id: string) {
  const row = await prisma.sound.findUnique({ where: { id } });
  if (!row) throw notFound("unknown_sound");
  requireEditor(userId, row);
  await prisma.sound.delete({ where: { id } });
  announce(row, "SOUND_DELETE", { id, guildId: row.guildId });
  await deleteStored(row.path);
  if (row.image) await removeImage(row.image);
}

/** An icon uploaded through /api/images lives in its own ULID folder. */
async function removeImage(url: string) {
  if (!url.startsWith("/files/")) return;
  const rel = url.slice("/files/".length).split("/").map(decodeURIComponent).join("/");
  await deleteStored(rel).catch(() => unlink(resolveStorage(rel)).catch(() => {}));
}

// ── voice presets ────────────────────────────────────────────────────────────
export async function createPreset(userId: string, input: { name: string; emoji?: string | null; params: VoiceParams; guildId?: string }): Promise<VoicePresetDTO> {
  requireShareable(userId, input.guildId);
  const count = input.guildId ? await prisma.voicePreset.count({ where: { guildId: input.guildId } }) : await prisma.voicePreset.count({ where: { ownerId: userId, guildId: null } });
  if (count >= (input.guildId ? MAX_GUILD_PRESETS : MAX_OWN_PRESETS)) throw badRequest("preset_limit");
  const row = await prisma.voicePreset.create({
    data: { id: ulid(), ownerId: userId, guildId: input.guildId ?? null, name: input.name, emoji: input.emoji ?? null, params: JSON.stringify(input.params) },
  });
  const dto = toPreset(row);
  announce(row, "VOICE_PRESET_UPSERT", dto);
  return dto;
}

export async function updatePreset(userId: string, id: string, patch: { name?: string; emoji?: string | null; params?: VoiceParams }): Promise<VoicePresetDTO> {
  const row = await prisma.voicePreset.findUnique({ where: { id } });
  if (!row) throw notFound("unknown_preset");
  requireEditor(userId, row);
  const updated = await prisma.voicePreset.update({
    where: { id },
    data: { name: patch.name ?? row.name, emoji: patch.emoji !== undefined ? patch.emoji : row.emoji, params: patch.params ? JSON.stringify(patch.params) : row.params },
  });
  const dto = toPreset(updated);
  announce(updated, "VOICE_PRESET_UPSERT", dto);
  return dto;
}

export async function deletePreset(userId: string, id: string) {
  const row = await prisma.voicePreset.findUnique({ where: { id } });
  if (!row) throw notFound("unknown_preset");
  requireEditor(userId, row);
  await prisma.voicePreset.delete({ where: { id } });
  announce(row, "VOICE_PRESET_DELETE", { id, guildId: row.guildId });
}
