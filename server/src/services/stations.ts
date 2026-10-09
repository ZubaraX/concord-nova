// Radio stations for FM. The catalogue ships with the server (data/stations.json,
// popular stations of Russia, refreshed by scripts/update-stations.mjs): the
// open catalogue it comes from, Radio Browser, is blocked in Russia, and FM must
// work without a VPN. When Radio Browser does answer from here, a search also
// gets stations of other countries from it.
import catalogue from "../data/stations.json";
import { config } from "../config";

export interface StationDTO {
  id: string;
  name: string;
  url: string;
  codec: string;
  bitrate: number;
  country: string;
  tags: string;
}

const CYR: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p",
  р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};
const latin = (s: string) => [...s].map((c) => CYR[c] ?? c).join("");
const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// Brands spelled in Latin that people search for in Cyrillic (and the other way round
// works through transliteration): extra words for their search keys.
const ALIASES: [RegExp, string][] = [
  [/europa/i, "европа"], [/retro/i, "ретро"], [/russk/i, "русское"], [/avto|auto ?radio/i, "авторадио"], [/dorozhn|dorojn/i, "дорожное"],
  [/record/i, "рекорд"], [/nashe/i, "наше"], [/energy/i, "энерджи"], [/maximum/i, "максимум"], [/love/i, "лав"], [/hit/i, "хит"],
  [/vesti/i, "вести"], [/mayak/i, "маяк"], [/humor|yumor/i, "юмор"], [/relax/i, "релакс"], [/rock/i, "рок"], [/chanson|shanson/i, "шансон"],
  [/romantik/i, "романтика"], [/kommersant/i, "коммерсант"], [/business/i, "бизнес"], [/monte ?carlo/i, "монте карло"], [/jazz/i, "джаз"],
  [/classic/i, "классика"], [/news/i, "новости"], [/sport/i, "спорт"], [/kids|deti|detsk/i, "детское"], [/like/i, "лайк"], [/zhara|jara/i, "жара"],
  [/marus/i, "маруся"], [/dfm/i, "дфм"], [/\bfm\b/i, "фм"], [/radio/i, "радио"], [/plus/i, "плюс"], [/dance/i, "дэнс танцевальное"],
];

const stations = catalogue as StationDTO[];
const keys = stations.map((s) => {
  const base = norm(`${s.name} ${s.tags}`);
  const extra = ALIASES.filter(([re]) => re.test(s.name)).map(([, w]) => w);
  return `${base} ${latin(base)} ${extra.join(" ")}`;
});

/** The most listened stations (the catalogue's own order). */
export function popularStations(limit = 50): StationDTO[] {
  return stations.slice(0, limit);
}

/** Stations whose name or genre has every word of the query, in either script. */
export function searchStations(q: string, limit = 40): StationDTO[] {
  const words = norm(q).split(" ").filter(Boolean);
  if (!words.length) return popularStations(limit);
  const out: StationDTO[] = [];
  for (let i = 0; i < stations.length && out.length < limit; i++) {
    if (words.every((w) => keys[i].includes(w) || keys[i].includes(latin(w)))) out.push(stations[i]);
  }
  return out;
}

// ── Radio Browser, when it answers from here ─────────────────────────────────
const MIRRORS = ["https://de1.api.radio-browser.info", "https://fi1.api.radio-browser.info"];
/** After a failure, don't keep everyone's searches waiting on it for a while. */
let downUntil = 0;

interface RawStation {
  stationuuid: string;
  name: string;
  url_resolved: string;
  codec: string;
  bitrate: number;
  countrycode: string;
  tags: string;
  hls: number;
  lastcheckok: number;
}

async function remoteSearch(q: string): Promise<StationDTO[]> {
  if (config.isTest || Date.now() < downUntil) return [];
  for (const base of MIRRORS) {
    try {
      const res = await fetch(`${base}/json/stations/search?name=${encodeURIComponent(q)}&order=clickcount&reverse=true&hidebroken=true&limit=40`, {
        headers: { "user-agent": "ConcordNova (self-hosted chat; FM search)" },
        signal: AbortSignal.timeout(3500),
      });
      if (!res.ok) continue;
      const list = (await res.json()) as RawStation[];
      return list
        .filter((s) => !s.hls && s.lastcheckok !== 0 && /^https?:\/\//i.test(s.url_resolved))
        .map((s) => ({ id: s.stationuuid, name: s.name.trim().slice(0, 120), url: s.url_resolved, codec: s.codec, bitrate: s.bitrate, country: s.countrycode, tags: s.tags.split(",").slice(0, 4).join(", ") }));
    } catch {
      /* next mirror */
    }
  }
  downUntil = Date.now() + 10 * 60_000;
  return [];
}

/** The built-in catalogue first; stations of other countries from Radio Browser after, when it's reachable. */
export async function findStations(q: string): Promise<StationDTO[]> {
  const local = searchStations(q);
  if (norm(q).length < 2) return local;
  const remote = await remoteSearch(q.trim());
  const seen = new Set(local.map((s) => s.url));
  const names = new Set(local.map((s) => s.name.toLowerCase()));
  return [...local, ...remote.filter((s) => !seen.has(s.url) && !names.has(s.name.toLowerCase()))].slice(0, 60);
}
