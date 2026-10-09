// FM: internet radio stations. The list comes from this server (its built-in
// catalogue of Russian stations — the open catalogue it's made from, Radio
// Browser, is blocked in Russia, so the app must not ask it itself). Turning a
// station on goes through the server too, which tells the call (and relays an
// http stream).
import { api } from "../../lib/api";
import { toast } from "../../lib/bus";
import { diag } from "../../lib/diag";
import { errorText } from "../../lib/i18n";

export interface FmStation {
  id: string;
  name: string;
  url: string;
  codec: string;
  bitrate: number;
  country: string;
  tags: string;
}

const ask = (q: string) => api<{ stations: FmStation[] }>(`/api/radio/stations?q=${encodeURIComponent(q.trim())}`).then((r) => r.stations);

let popularCache: Promise<FmStation[]> | null = null;
/** The most listened stations of Russia. */
export function popularStations(): Promise<FmStation[]> {
  popularCache ??= ask("").catch((e) => {
    popularCache = null;
    throw e;
  });
  return popularCache;
}

/** Stations by name or genre, in Russian or Latin letters. */
export const searchStations = (q: string): Promise<FmStation[]> => ask(q);

/** Turns the station on for everyone in the call (another one replaces it). */
export async function turnOn(channelId: string, s: FmStation) {
  try {
    await api(`/api/channels/${channelId}/radio/station`, { method: "POST", body: { name: s.name.slice(0, 120), url: s.url, uuid: s.id } });
    diag("radio", "station on", { name: s.name, url: s.url });
  } catch (e) {
    toast(errorText(e), "error");
  }
}

export async function turnOff(channelId: string) {
  await api(`/api/channels/${channelId}/radio/station`, { method: "DELETE" }).catch((e) => toast(errorText(e), "error"));
}
