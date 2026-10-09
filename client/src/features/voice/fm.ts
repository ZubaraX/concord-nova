// FM: internet radio stations from Radio Browser (radio-browser.info — an open
// catalogue anyone may use; stations publish these streams for listening).
// The catalogue is asked from this device; turning a station on goes through
// the server, which tells the call (and relays an http stream).
import { api } from "../../lib/api";
import { toast } from "../../lib/bus";
import { diag } from "../../lib/diag";
import { errorText } from "../../lib/i18n";

export interface FmStation {
  id: string;
  name: string;
  url: string;
  favicon: string | null;
  codec: string;
  bitrate: number;
  country: string;
  tags: string;
}

/** Mirrors of the catalogue; the next one is tried when one doesn't answer. */
const MIRRORS = ["https://de1.api.radio-browser.info", "https://de2.api.radio-browser.info", "https://fi1.api.radio-browser.info"];

async function ask<T>(path: string): Promise<T> {
  let last: unknown;
  for (const base of MIRRORS) {
    try {
      const res = await fetch(base + path, { signal: AbortSignal.timeout(8000) });
      if (res.ok) return (await res.json()) as T;
      last = new Error(`HTTP ${res.status}`);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

interface RawStation {
  stationuuid: string;
  name: string;
  url_resolved: string;
  favicon: string;
  codec: string;
  bitrate: number;
  countrycode: string;
  tags: string;
  hls: number;
  lastcheckok: number;
}

/** Playable here: alive, not HLS (which browsers other than phones don't play on their own), http(s). */
const playable = (s: RawStation) => s.lastcheckok !== 0 && !s.hls && /^https?:\/\//i.test(s.url_resolved);

const toStation = (s: RawStation): FmStation => ({
  id: s.stationuuid,
  name: s.name.trim(),
  url: s.url_resolved,
  favicon: /^https?:\/\//i.test(s.favicon) ? s.favicon : null,
  codec: s.codec,
  bitrate: s.bitrate,
  country: s.countrycode,
  tags: s.tags,
});

function dedupe(list: FmStation[]): FmStation[] {
  const seen = new Set<string>();
  return list.filter((s) => {
    const k = s.name.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

let popularCache: Promise<FmStation[]> | null = null;
/** The most listened stations of Russia. */
export function popularStations(): Promise<FmStation[]> {
  popularCache ??= ask<RawStation[]>("/json/stations/search?countrycode=RU&order=clickcount&reverse=true&hidebroken=true&limit=80")
    .then((l) => dedupe(l.filter(playable).map(toStation)).slice(0, 50))
    .catch((e) => {
      popularCache = null;
      throw e;
    });
  return popularCache;
}

/** Stations of any country by name. */
export async function searchStations(q: string): Promise<FmStation[]> {
  const list = await ask<RawStation[]>(`/json/stations/search?name=${encodeURIComponent(q.trim())}&order=clickcount&reverse=true&hidebroken=true&limit=60`);
  return dedupe(list.filter(playable).map(toStation)).slice(0, 40);
}

/** Turns the station on for everyone in the call (another one replaces it). */
export async function turnOn(channelId: string, s: FmStation) {
  try {
    await api(`/api/channels/${channelId}/radio/station`, { method: "POST", body: { name: s.name.slice(0, 120), url: s.url, favicon: s.favicon ?? undefined, uuid: s.id } });
    diag("radio", "station on", { name: s.name, url: s.url });
    // The catalogue counts listens this way (its own request).
    void ask(`/json/url/${encodeURIComponent(s.id)}`).catch(() => {});
  } catch (e) {
    toast(errorText(e), "error");
  }
}

export async function turnOff(channelId: string) {
  await api(`/api/channels/${channelId}/radio/station`, { method: "DELETE" }).catch((e) => toast(errorText(e), "error"));
}
