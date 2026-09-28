// Minimal static file sender with HTTP Range support (video seeking, voice
// messages) and safe headers. Used for /files and the media-proxy cache.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyReply, FastifyRequest } from "fastify";
import { notFound } from "./errors";

export const FILE_CSP = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox";

export async function sendFile(
  req: FastifyRequest,
  reply: FastifyReply,
  full: string,
  contentType: string,
  headers: Record<string, string> = {}
) {
  let st;
  try {
    st = await stat(full);
  } catch {
    throw notFound("unknown_file");
  }
  if (!st.isFile()) throw notFound("unknown_file");
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  reply.header("Content-Type", contentType);
  reply.header("Accept-Ranges", "bytes");
  reply.header("ETag", etag);
  reply.header("Last-Modified", st.mtime.toUTCString());
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Content-Security-Policy", FILE_CSP);
  reply.header("Cross-Origin-Resource-Policy", "cross-origin");
  for (const [k, v] of Object.entries(headers)) reply.header(k, v);

  if (req.headers["if-none-match"] === etag) return reply.code(304).send();

  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : NaN;
      let end = m[2] ? parseInt(m[2], 10) : NaN;
      if (Number.isNaN(start)) {
        start = Math.max(0, st.size - (Number.isNaN(end) ? 0 : end));
        end = st.size - 1;
      } else if (Number.isNaN(end) || end >= st.size) end = st.size - 1;
      if (start > end || start >= st.size) {
        reply.header("Content-Range", `bytes */${st.size}`);
        return reply.code(416).send();
      }
      reply.header("Content-Range", `bytes ${start}-${end}/${st.size}`);
      reply.header("Content-Length", String(end - start + 1));
      reply.code(206);
      if (req.method === "HEAD") return reply.send();
      return reply.send(createReadStream(full, { start, end }));
    }
  }
  reply.header("Content-Length", String(st.size));
  if (req.method === "HEAD") return reply.send();
  return reply.send(createReadStream(full));
}
