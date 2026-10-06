// File storage: uploads live under <storageDir>/<yyyy>/<mm>/<ulid>/<name> and
// are served at /files/<same path>. The ULID directory makes URLs unguessable.
// Images get dimensions on upload and resized variants on demand (?w=), cached
// on disk, so phones don't download 12-megapixel photos to show a thumbnail.
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile, open } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import sharp from "sharp";
import { ulid } from "@nova/shared";
import { config } from "../config";
import { ApiError, badRequest } from "./errors";

sharp.cache(false);
sharp.concurrency(2);

export const storageDir = config.storageDir;
export const cacheDir = config.cacheDir;

export function sanitizeFilename(name: string): string {
  const base = (name || "file")
    .normalize("NFC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .trim();
  const ext = extname(base).slice(0, 16);
  const stem = base.slice(0, base.length - ext.length).slice(0, 100) || "file";
  return stem + ext;
}

export function newRelPath(filename: string): string {
  const d = new Date();
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}/${mm}/${ulid()}/${sanitizeFilename(filename)}`;
}

/** Resolve a /files/-relative path safely inside the storage dir (no traversal). */
export function resolveStorage(rel: string): string {
  const clean = normalize(rel).replace(/^([/\\])+/, "");
  const full = resolve(storageDir, clean);
  if (!full.startsWith(resolve(storageDir) + sep)) throw badRequest("invalid_path");
  return full;
}

export const publicUrl = (rel: string) => `/files/${rel.split("/").map(encodeURIComponent).join("/")}`;

/** Stream to disk, enforcing a byte limit (0 = unlimited). Returns bytes written. */
export async function saveStream(stream: Readable, rel: string, maxBytes: number): Promise<number> {
  const full = resolveStorage(rel);
  await mkdir(dirname(full), { recursive: true });
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (maxBytes > 0 && size > maxBytes) return cb(new ApiError(413, "file_too_large"));
      cb(null, chunk);
    },
  });
  try {
    await pipeline(stream, counter, createWriteStream(full));
  } catch (e) {
    await rm(dirname(full), { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  return size;
}

export async function saveBuffer(buf: Buffer, rel: string) {
  const full = resolveStorage(rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, buf);
}

export async function deleteStored(rel: string) {
  try {
    const full = resolveStorage(rel);
    // Remove the whole ULID directory (the file and nothing else lives there).
    await rm(dirname(full), { recursive: true, force: true });
  } catch {
    /* already gone */
  }
}

/** Magic-byte sniffing for the types we render inline. */
export async function sniffFile(full: string): Promise<string | null> {
  const fh = await open(full, "r");
  try {
    const head = Buffer.alloc(32);
    await fh.read(head, 0, 32, 0);
    const s = (a: number, b: number) => head.subarray(a, b).toString("latin1");
    if (head[0] === 0x89 && s(1, 4) === "PNG") return "image/png";
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
    if (s(0, 6) === "GIF87a" || s(0, 6) === "GIF89a") return "image/gif";
    if (s(0, 4) === "RIFF" && s(8, 12) === "WEBP") return "image/webp";
    if (s(0, 4) === "RIFF" && s(8, 12) === "WAVE") return "audio/wav";
    if (s(4, 8) === "ftyp") {
      const brand = s(8, 12);
      if (brand === "avif" || brand === "avis") return "image/avif";
      if (/^(heic|heix|hevc|mif1|msf1)$/.test(brand)) return "image/heic";
      if (/^(M4A |M4B )$/.test(brand)) return "audio/mp4";
      if (/^(qt  )$/.test(brand)) return "video/quicktime";
      return "video/mp4";
    }
    if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "video/webm";
    if (s(0, 4) === "OggS") return "audio/ogg";
    if (s(0, 3) === "ID3" || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return "audio/mpeg";
    if (s(0, 4) === "fLaC") return "audio/flac";
    if (s(0, 5) === "%PDF-") return "application/pdf";
    return null;
  } finally {
    await fh.close();
  }
}

/** Types safe to render inline in the browser. Everything else downloads. */
export const INLINE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/mp4",
  "audio/flac",
  "audio/webm",
]);

const EXT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
};

export function typeFromName(name: string): string | null {
  return EXT_TYPES[extname(name).toLowerCase()] ?? null;
}

export async function imageSize(full: string): Promise<{ width: number; height: number; animated: boolean } | null> {
  try {
    const m = await sharp(full, { animated: true, limitInputPixels: 268_402_689 }).metadata();
    if (!m.width || !m.height) return null;
    const pages = m.pages ?? 1;
    return { width: m.width, height: m.pageHeight ?? (pages > 1 ? Math.round(m.height / pages) : m.height), animated: pages > 1 };
  } catch {
    return null;
  }
}

export async function convertHeicToJpeg(full: string): Promise<Buffer | null> {
  try {
    const { default: convert } = await import("heic-convert");
    const out = await convert({ buffer: await readFile(full), format: "JPEG", quality: 0.88 });
    return Buffer.isBuffer(out) ? out : Buffer.from(new Uint8Array(out));
  } catch {
    return null;
  }
}

export type ImageKind = "avatar" | "banner" | "icon" | "guild_banner" | "emoji" | "group_icon" | "sound_icon";

const KIND_SPEC: Record<ImageKind, { w: number; h: number; fit: "cover" | "contain"; maxInput: number }> = {
  avatar: { w: 256, h: 256, fit: "cover", maxInput: 10 * 1024 * 1024 },
  icon: { w: 256, h: 256, fit: "cover", maxInput: 10 * 1024 * 1024 },
  group_icon: { w: 256, h: 256, fit: "cover", maxInput: 10 * 1024 * 1024 },
  banner: { w: 1200, h: 480, fit: "cover", maxInput: 15 * 1024 * 1024 },
  guild_banner: { w: 1600, h: 640, fit: "cover", maxInput: 15 * 1024 * 1024 },
  emoji: { w: 128, h: 128, fit: "contain", maxInput: 2 * 1024 * 1024 },
  sound_icon: { w: 96, h: 96, fit: "cover", maxInput: 8 * 1024 * 1024 },
};

export async function readLimited(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of stream) {
    size += (c as Buffer).length;
    if (size > maxBytes) throw new ApiError(413, "file_too_large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Normalize a profile/guild image: crop/fit to the kind's box and re-encode as
 * WebP (animation preserved). Re-encoding also strips metadata (EXIF/GPS).
 */
export async function processImage(input: Buffer, kind: ImageKind): Promise<{ rel: string; animated: boolean }> {
  const spec = KIND_SPEC[kind];
  if (input.length > spec.maxInput) throw new ApiError(413, "file_too_large");
  let meta: sharp.Metadata;
  try {
    meta = await sharp(input, { animated: true }).metadata();
  } catch {
    throw badRequest("invalid_image");
  }
  if (!meta.width || !meta.height) throw badRequest("invalid_image");
  const animated = (meta.pages ?? 1) > 1;
  const out = await sharp(input, { animated })
    .rotate()
    .resize(spec.w, spec.h, { fit: spec.fit, background: { r: 0, g: 0, b: 0, alpha: 0 }, withoutEnlargement: kind === "emoji" ? false : true })
    .webp({ quality: 88, effort: 4, loop: 0 })
    .toBuffer();
  const rel = newRelPath(`${kind}.webp`);
  await saveBuffer(out, rel);
  return { rel, animated };
}

const RESIZE_WIDTHS = [96, 160, 320, 480, 640, 960, 1280, 1920];
const RESIZABLE = new Set(["image/png", "image/jpeg", "image/webp", "image/avif", "image/gif"]);

/** Nearest allowed width ≥ requested (bounded set keeps the cache finite). */
export function snapWidth(w: number): number {
  return RESIZE_WIDTHS.find((x) => x >= w) ?? RESIZE_WIDTHS[RESIZE_WIDTHS.length - 1];
}

/** Returns a cached resized WebP for an image, or null when not applicable. */
export async function resizedVariant(rel: string, width: number): Promise<string | null> {
  const src = resolveStorage(rel);
  const type = typeFromName(src);
  if (!type || !RESIZABLE.has(type)) return null;
  const w = snapWidth(width);
  const out = resolve(cacheDir, `w${w}`, normalize(rel).replace(/^([/\\])+/, "") + ".webp");
  if (!out.startsWith(resolve(cacheDir) + sep)) return null;
  try {
    await stat(out);
    return out;
  } catch {
    /* not cached yet */
  }
  try {
    const meta = await sharp(src, { animated: true }).metadata();
    if (meta.width && meta.width <= w) return null; // already small — serve the original
    await mkdir(dirname(out), { recursive: true });
    const tmp = out + "." + ulid() + ".tmp";
    await sharp(src, { animated: (meta.pages ?? 1) > 1 })
      .rotate()
      .resize({ width: w, withoutEnlargement: true })
      .webp({ quality: 82, effort: 3 })
      .toFile(tmp);
    const { rename } = await import("node:fs/promises");
    await rename(tmp, out);
    return out;
  } catch {
    return null;
  }
}

export function joinRel(...parts: string[]) {
  return join(...parts).replace(/\\/g, "/");
}
