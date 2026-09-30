// Uploads (attachments + profile/guild images), file serving, the signed
// external-image proxy, and the GIF search key.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AttachmentFlags, ulid, type GifConfigDTO } from "@nova/shared";
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
import { instance } from "../services/instance";

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

  // ── GIF search ──
  // KLIPY wants searches and media loads to come from the app itself, not from
  // a server in between, so signed-in clients get the app key and ask directly.
  app.get("/api/gifs/config", { preHandler: authenticate }, async (): Promise<GifConfigDTO> => {
    const key = instance.gifKey;
    return { provider: key ? "klipy" : null, key: key || null };
  });

  void storageDir;
}
