// Uploads (attachments + profile/guild images), file serving, the signed
// external-image proxy, and GIF search.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AttachmentFlags, ulid, type GifDTO } from "@nova/shared";
import { prisma } from "../db";
import { config } from "../config";
import { authenticate } from "../lib/auth";
import { ApiError, badRequest, notFound, parse } from "../lib/errors";
import { limits } from "../lib/rate";
import {
  INLINE_TYPES,
  cacheDir,
  convertHeicToJpeg,
  imageSize,
  newRelPath,
  processImage,
  publicUrl,
  readLimited,
  resizedVariant,
  resolveStorage,
  sanitizeFilename,
  saveStream,
  sniffFile,
  storageDir,
  typeFromName,
  type ImageKind,
} from "../lib/files";
import { sendFile } from "../lib/serve";
import { safeFetch } from "../lib/ssrf";
import { toAttachment } from "../services/serialize";
import { verifyProxy } from "../services/embeds";

const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/;

export async function fileRoutes(app: FastifyInstance) {
  // ── attachment upload ──
  app.post("/api/attachments", { preHandler: authenticate }, async (req, reply) => {
    const userId = req.auth.userId;
    limits.uploads.consume(userId);
    const q = parse(
      z.object({
        voice: z.enum(["0", "1"]).optional(),
        spoiler: z.enum(["0", "1"]).optional(),
        duration: z.coerce.number().min(0).max(3600).optional(),
        waveform: z.string().max(400).regex(/^[A-Za-z0-9+/=]*$/).optional(),
      }),
      req.query
    );
    const file = await req.file({ limits: { fileSize: config.MAX_UPLOAD_BYTES > 0 ? config.MAX_UPLOAD_BYTES : Number.MAX_SAFE_INTEGER } });
    if (!file) throw badRequest("no_file");
    let filename = sanitizeFilename(file.filename || "file");
    let rel = newRelPath(filename);
    let size = await saveStream(file.file, rel, config.MAX_UPLOAD_BYTES);
    if (file.file.truncated) throw new ApiError(413, "file_too_large");
    let full = resolveStorage(rel);

    const sniffed = await sniffFile(full);
    let contentType = sniffed ?? typeFromName(filename) ?? (MIME_RE.test(file.mimetype) ? file.mimetype : "application/octet-stream");

    // iPhone photos (HEIC) → JPEG once, so every client can display them.
    if (sniffed === "image/heic") {
      const jpeg = await convertHeicToJpeg(full);
      if (jpeg) {
        filename = filename.replace(/\.[^.]*$/, "") + ".jpg";
        const next = rel.replace(/[^/]+$/, filename);
        await writeFile(resolveStorage(next), jpeg);
        if (next !== rel) await unlink(full).catch(() => {});
        rel = next;
        full = resolveStorage(rel);
        size = jpeg.length;
        contentType = "image/jpeg";
      }
    }

    let width: number | null = null;
    let height: number | null = null;
    if (contentType.startsWith("image/")) {
      const dims = await imageSize(full);
      width = dims?.width ?? null;
      height = dims?.height ?? null;
    }
    let flags = 0;
    if (q.voice === "1" && contentType.startsWith("audio/")) flags |= AttachmentFlags.VOICE_MESSAGE;
    else if (q.voice === "1" && contentType === "video/webm") {
      // MediaRecorder audio-only webm sniffs as video/webm.
      contentType = "audio/webm";
      flags |= AttachmentFlags.VOICE_MESSAGE;
    }
    if (q.spoiler === "1") flags |= AttachmentFlags.SPOILER;

    const row = await prisma.attachment.create({
      data: {
        id: ulid(),
        uploaderId: userId,
        filename,
        path: rel,
        size: BigInt(size),
        contentType,
        width,
        height,
        duration: q.duration ?? null,
        waveform: flags & AttachmentFlags.VOICE_MESSAGE ? q.waveform ?? null : null,
        flags,
      },
    });
    return reply.code(201).send(toAttachment(row));
  });

  // ── profile / guild images (normalized WebP) ──
  app.post("/api/images", { preHandler: authenticate }, async (req) => {
    limits.uploads.consume(req.auth.userId);
    const { kind } = parse(z.object({ kind: z.enum(["avatar", "banner", "icon", "guild_banner", "group_icon"]) }), req.query);
    const file = await req.file();
    if (!file) throw badRequest("no_file");
    const buf = await readLimited(file.file, 16 * 1024 * 1024);
    const { rel, animated } = await processImage(buf, kind as ImageKind);
    return { url: publicUrl(rel), animated };
  });

  // ── serving ──
  const serve = async (req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => {
    const raw = (req.params as { "*": string })["*"] ?? "";
    let rel: string;
    try {
      rel = decodeURIComponent(raw);
    } catch {
      throw notFound("unknown_file");
    }
    const full = resolveStorage(rel);
    const { w, download } = req.query as { w?: string; download?: string };
    const type = typeFromName(full);
    const immutable = { "Cache-Control": "public, max-age=31536000, immutable" };
    if (w && type?.startsWith("image/")) {
      const variant = await resizedVariant(rel, Math.max(16, Math.min(4096, Number(w) || 0)));
      if (variant) return sendFile(req, reply, variant, "image/webp", immutable);
    }
    const inline = !!type && INLINE_TYPES.has(type) && download !== "1";
    const name = basename(full);
    return sendFile(req, reply, full, inline ? type! : "application/octet-stream", {
      ...immutable,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
    });
  };
  app.get("/files/*", serve); // Fastify adds HEAD automatically

  // ── external image proxy (signed URLs only) ──
  app.get("/media-proxy", async (req, reply) => {
    const { u, s } = parse(z.object({ u: z.string().max(4000), s: z.string().max(64) }), req.query);
    const url = verifyProxy(u, s);
    if (!url) throw notFound("unknown_media");
    const key = createHash("sha256").update(url).digest("hex");
    const dir = resolve(cacheDir, "proxy", key.slice(0, 2));
    const file = resolve(dir, key);
    const headers = { "Cache-Control": "public, max-age=604800" };
    try {
      const [type] = await Promise.all([readFile(file + ".type", "utf8"), stat(file)]);
      return sendFile(req, reply, file, type, headers);
    } catch {
      /* not cached */
    }
    let res;
    try {
      res = await safeFetch(url, { maxBytes: 15 * 1024 * 1024, timeoutMs: 10_000, accept: "image/avif,image/webp,image/*;q=0.9" });
    } catch {
      throw notFound("unknown_media");
    }
    const type = res.contentType.split(";")[0].trim().toLowerCase();
    if (res.status !== 200 || !/^image\/(png|jpeg|gif|webp|avif)$/.test(type)) throw notFound("unknown_media");
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${ulid()}.tmp`;
    await writeFile(tmp, res.body);
    await rename(tmp, file);
    await writeFile(file + ".type", type);
    return sendFile(req, reply, file, type, headers);
  });

  // ── GIF search (KLIPY, or Tenor as a fallback) ──
  app.get("/api/gifs/search", { preHandler: authenticate }, async (req) => {
    const { q, page } = parse(z.object({ q: z.string().max(100).optional(), page: z.coerce.number().int().min(1).max(50).optional() }), req.query);
    const query = (q ?? "").trim();
    const pg = page ?? 1;
    try {
      if (config.KLIPY_KEY) return { results: await klipy(config.KLIPY_KEY, query, req.auth.userId, pg), page: pg };
      if (config.TENOR_KEY) return { results: pg === 1 ? await tenor(config.TENOR_KEY, query) : [], page: pg };
    } catch (err) {
      req.log.warn({ err }, "gif search failed");
    }
    return { results: [] as GifDTO[], page: pg };
  });

  void storageDir;
}

async function getJson(url: string): Promise<unknown> {
  let last: unknown;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(6000), headers: { accept: "application/json", "user-agent": "ConcordNova/1.0" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

interface KlipyMedia {
  url?: string;
  width?: number;
  height?: number;
}
type KlipyFile = Record<string, Record<string, KlipyMedia> | undefined>;

async function klipy(key: string, q: string, customerId: string, page: number): Promise<GifDTO[]> {
  const base = `https://api.klipy.com/api/v1/${encodeURIComponent(key)}/gifs`;
  const params = `per_page=30&page=${page}&customer_id=${encodeURIComponent(customerId)}&rating=pg-13&locale=ru`;
  const url = q ? `${base}/search?${params}&q=${encodeURIComponent(q)}` : `${base}/trending?${params}`;
  const j = (await getJson(url)) as { data?: { data?: { id?: string | number; slug?: string; file?: KlipyFile }[] } };
  const pick = (f: KlipyFile | undefined, sizes: string[]) => {
    for (const s of sizes) for (const fmt of ["gif", "webp"]) {
      const m = f?.[s]?.[fmt];
      if (m?.url) return m;
    }
    return undefined;
  };
  return (j.data?.data ?? [])
    .map((it) => {
      const full = pick(it.file, ["md", "hd", "sm", "xs"]);
      const prev = pick(it.file, ["sm", "xs", "md"]);
      return { id: String(it.id ?? it.slug ?? ""), url: full?.url ?? "", preview: prev?.url ?? full?.url ?? "", width: full?.width ?? null, height: full?.height ?? null };
    })
    .filter((g) => g.url);
}

async function tenor(key: string, q: string): Promise<GifDTO[]> {
  const common = `key=${encodeURIComponent(key)}&client_key=concord-nova&limit=30&media_filter=gif,tinygif&contentfilter=medium&locale=ru_RU`;
  const url = q ? `https://tenor.googleapis.com/v2/search?${common}&q=${encodeURIComponent(q)}` : `https://tenor.googleapis.com/v2/featured?${common}`;
  const j = (await getJson(url)) as { results?: { id: string; media_formats?: Record<string, { url: string; dims?: [number, number] }> }[] };
  return (j.results ?? [])
    .map((g) => ({
      id: g.id,
      url: g.media_formats?.gif?.url ?? "",
      preview: g.media_formats?.tinygif?.url ?? g.media_formats?.gif?.url ?? "",
      width: g.media_formats?.gif?.dims?.[0] ?? null,
      height: g.media_formats?.gif?.dims?.[1] ?? null,
    }))
    .filter((g) => g.url);
}
