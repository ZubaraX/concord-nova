// The radio of a voice channel: only people in that call may change it.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Permission, isMusicServiceLink, radioItemCreateSchema, radioLinkCreateSchema, radioPreviousSchema, radioSkipSchema, radioStationSchema, zId } from "@nova/shared";
import { config } from "../config";
import { authenticate } from "../lib/auth";
import { ApiError, badRequest, forbidden, parse } from "../lib/errors";
import { stationPlayUrl, verifyRelay } from "../lib/radioRelay";
import { openStream } from "../lib/ssrf";
import { pageInfo, proxied } from "../services/embeds";
import { findStations } from "../services/stations";
import { cache } from "../state/cache";
import { radio } from "../state/radio";
import { voice } from "../state/voice";

const params = z.object({ id: zId });
const itemParams = z.object({ id: zId, itemId: zId });

/** A music page's title without the site's own tail ("… слушать онлайн", "— Яндекс Музыка"). */
export function tileTitle(title: string | null): string | null {
  if (!title) return null;
  const t = title
    // (\b knows no Cyrillic: a space or the end marks the word's end instead.)
    .replace(/\s*[.:|—-]?\s*(слушать|listen)(\s.*)?$/i, "")
    .replace(/\s*[|—-]\s*(Яндекс\s*Музыка|Yandex\s*Music|ВКонтакте|VK)\s*$/i, "")
    .trim();
  return t.slice(0, 200) || null;
}

function inCall(userId: string, channelId: string) {
  if (voice.get(userId)?.channelId !== channelId) throw forbidden("not_in_call");
}

/** Playing to the channel is speaking in it: a server mute or no "speak" covers the radio too. */
function maySpeak(userId: string, channelId: string) {
  inCall(userId, channelId);
  if (!voice.rightsFor(userId, channelId).rights.mic) throw forbidden("muted");
}

export async function radioRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  app.get("/api/channels/:id/radio", async (req) => {
    const { id } = parse(params, req.params);
    if (!cache.canView(id, req.auth.userId)) throw forbidden("missing_access");
    return radio.state(id);
  });
  app.post("/api/channels/:id/radio/items", async (req) => {
    const { id } = parse(params, req.params);
    maySpeak(req.auth.userId, id);
    const input = parse(radioItemCreateSchema, req.body);
    if (input.url && isMusicServiceLink(input.url)) throw badRequest("music_service_link");
    return radio.add(id, req.auth.userId, input);
  });
  app.post("/api/channels/:id/radio/links", async (req) => {
    const { id } = parse(params, req.params);
    inCall(req.auth.userId, id);
    const input = parse(radioLinkCreateSchema, req.body);
    const service = isMusicServiceLink(input.url);
    if (!service) throw badRequest("not_a_music_service_link");
    const link = radio.addLink(id, req.auth.userId, input, service);
    // The tile's title and cover, from the page, a moment later.
    void pageInfo(input.url)
      .then((info) => info && radio.updateLink(id, link.id, { title: tileTitle(info.title), image: info.image }))
      .catch(() => {});
    return link;
  });
  app.delete("/api/channels/:id/radio/items/:itemId", async (req) => {
    const { id, itemId } = parse(itemParams, req.params);
    inCall(req.auth.userId, id);
    const moderator = !!cache.guildOf(id) && cache.can(id, req.auth.userId, Permission.MOVE_MEMBERS);
    radio.remove(id, req.auth.userId, itemId, moderator);
    return radio.state(id);
  });
  app.post("/api/channels/:id/radio/skip", async (req) => {
    const { id } = parse(params, req.params);
    maySpeak(req.auth.userId, id);
    radio.skip(id, parse(radioSkipSchema, req.body).itemId);
    return radio.state(id);
  });
  app.post("/api/channels/:id/radio/previous", async (req) => {
    const { id } = parse(params, req.params);
    maySpeak(req.auth.userId, id);
    radio.previous(id, parse(radioPreviousSchema, req.body).itemId);
    return radio.state(id);
  });
  app.post("/api/channels/:id/radio/items/:itemId/play", async (req) => {
    const { id, itemId } = parse(itemParams, req.params);
    maySpeak(req.auth.userId, id);
    radio.playNow(id, itemId);
    return radio.state(id);
  });
  // FM: the stations to choose from — served from here, not the (blocked in Russia) catalogue site.
  app.get("/api/radio/stations", async (req) => {
    const { q } = parse(z.object({ q: z.string().max(100).optional() }), req.query);
    return { stations: await findStations(q ?? "") };
  });

  // FM: a station on (another replaces it), or off.
  app.post("/api/channels/:id/radio/station", async (req) => {
    const { id } = parse(params, req.params);
    maySpeak(req.auth.userId, id);
    const input = parse(radioStationSchema, req.body);
    radio.setStation(id, req.auth.userId, { name: input.name, url: input.url, play: stationPlayUrl(input.url), favicon: proxied(input.favicon) });
    return radio.state(id);
  });
  app.delete("/api/channels/:id/radio/station", async (req) => {
    const { id } = parse(params, req.params);
    maySpeak(req.auth.userId, id);
    radio.clearStation(id);
    return radio.state(id);
  });

  for (const action of ["pause", "resume"] as const)
    app.post(`/api/channels/:id/radio/${action}`, async (req) => {
      const { id } = parse(params, req.params);
      maySpeak(req.auth.userId, id);
      radio[action](id);
      return radio.state(id);
    });
}

// ── the relay for http stations ──────────────────────────────────────────────
// No sign-in here: an audio element can't send one. The address must be one this
// server signed (when a station was turned on); the stream is passed on as it
// comes, never kept. A few at a time, so the relay can't be borrowed for much.
const MAX_RELAYS = 64;
const MAX_PER_IP = 4;
let relays = 0;
const perIp = new Map<string, number>();

export async function radioRelayRoutes(app: FastifyInstance) {
  app.get("/api/radio/relay", async (req, reply) => {
    const { u, s } = parse(z.object({ u: z.string().max(4000), s: z.string().max(64) }), req.query);
    const url = verifyRelay(u, s);
    if (!url) throw forbidden("bad_signature");
    if (relays >= MAX_RELAYS || (perIp.get(req.ip) ?? 0) >= MAX_PER_IP) throw new ApiError(429, "relay_busy");
    const ctl = new AbortController();
    let upstream: Awaited<ReturnType<typeof openStream>>;
    try {
      upstream = await openStream(url, { signal: ctl.signal, allowPrivate: config.isTest });
    } catch {
      throw new ApiError(502, "station_unreachable");
    }
    relays++;
    perIp.set(req.ip, (perIp.get(req.ip) ?? 0) + 1);
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      relays--;
      const n = (perIp.get(req.ip) ?? 1) - 1;
      if (n > 0) perIp.set(req.ip, n);
      else perIp.delete(req.ip);
      ctl.abort();
      upstream.destroy();
    };
    req.raw.on("close", done);
    upstream.on("end", done);
    upstream.on("error", done);
    const type = String(upstream.headers["content-type"] ?? "");
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": /^audio\/[\w.+-]+/i.test(type) ? type : "audio/mpeg", "cache-control": "no-store" });
    upstream.pipe(reply.raw);
  });
}
