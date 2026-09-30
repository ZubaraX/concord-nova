// Favourite GIFs: what a user starred in chat or in the picker, kept on the
// server so every device shows the same list. Works without any GIF search.
import { MAX_FAVORITE_GIFS, type GifDTO } from "@nova/shared";
import { prisma } from "../db";
import { badRequest } from "../lib/errors";
import { publicUrl } from "../lib/files";
import { toUser } from "../gateway/io";

interface Row {
  url: string;
  preview: string | null;
  width: number | null;
  height: number | null;
}

const toGif = (r: Row): GifDTO => ({ id: r.url, url: r.url, preview: r.preview ?? r.url, width: r.width, height: r.height });

/** Newest first. */
export async function listFavoriteGifs(userId: string): Promise<GifDTO[]> {
  const rows = await prisma.favoriteGif.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: MAX_FAVORITE_GIFS });
  return rows.map(toGif);
}

export async function addFavoriteGif(userId: string, input: { url: string; preview?: string | null; width?: number | null; height?: number | null }): Promise<GifDTO> {
  const data = { preview: input.preview ?? null, width: input.width ?? null, height: input.height ?? null };
  const known = await prisma.favoriteGif.findUnique({ where: { userId_url: { userId, url: input.url } } });
  if (!known && (await prisma.favoriteGif.count({ where: { userId } })) >= MAX_FAVORITE_GIFS) throw badRequest("gif_limit");
  // Starring again moves the GIF back to the top.
  const row = await prisma.favoriteGif.upsert({
    where: { userId_url: { userId, url: input.url } },
    create: { userId, url: input.url, ...data },
    update: { ...data, createdAt: new Date() },
  });
  const gif = toGif(row);
  toUser(userId, "USER_GIFS_UPDATE", { added: gif });
  return gif;
}

export async function removeFavoriteGif(userId: string, url: string) {
  const { count } = await prisma.favoriteGif.deleteMany({ where: { userId, url } });
  if (count) toUser(userId, "USER_GIFS_UPDATE", { removed: url });
}

/** Uploaded files that were deleted can't stay in anybody's favourites. */
export async function forgetFiles(paths: string[]) {
  if (!paths.length) return;
  const rows = await prisma.favoriteGif.findMany({ where: { url: { in: paths.map(publicUrl) } }, select: { userId: true, url: true } });
  if (!rows.length) return;
  await prisma.favoriteGif.deleteMany({ where: { url: { in: rows.map((r) => r.url) } } });
  for (const r of rows) toUser(r.userId, "USER_GIFS_UPDATE", { removed: r.url });
}
