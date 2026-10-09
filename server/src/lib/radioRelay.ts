// FM stations: an https stream plays straight from the station; an http one —
// which an https app may not load — goes through this server, relayed as it
// comes and never kept. The relay only opens addresses this server signed when
// someone turned the station on (a key of its own, apart from the image proxy).
import { createHmac } from "node:crypto";
import { config } from "../config";

const sig = (u: string) => createHmac("sha256", config.jwtSecret).update("radio-relay:" + u).digest("base64url").slice(0, 22);

/** What players load for a station's stream. */
export function stationPlayUrl(url: string): string {
  if (/^https:\/\//i.test(url)) return url;
  return `/api/radio/relay?u=${Buffer.from(url).toString("base64url")}&s=${sig(url)}`;
}

export function verifyRelay(u: string, s: string): string | null {
  try {
    const url = Buffer.from(u, "base64url").toString("utf8");
    return /^https?:\/\//i.test(url) && sig(url) === s ? url : null;
  } catch {
    return null;
  }
}
