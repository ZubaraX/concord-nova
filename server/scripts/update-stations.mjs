// Refreshes server/src/data/stations.json — the built-in catalogue of radio
// stations (popular in Russia), from Radio Browser (radio-browser.info, an open
// catalogue). It ships with the server because the catalogue site itself is
// blocked in Russia: FM search must work without a VPN.
//   node server/scripts/update-stations.mjs   (from a network that reaches it)
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MIRRORS = ["https://de1.api.radio-browser.info", "https://de2.api.radio-browser.info", "https://fi1.api.radio-browser.info"];
async function ask(path) {
  for (const base of MIRRORS) {
    try {
      const res = await fetch(base + path, { headers: { "user-agent": "ConcordNova/1.10 (station catalogue)" }, signal: AbortSignal.timeout(20_000) });
      if (res.ok) return res.json();
    } catch {
      /* next mirror */
    }
  }
  throw new Error("Radio Browser is not reachable from here");
}

const kbps = (b) => (b >= 8000 ? Math.round(b / 1000) : b);

const raw = await ask("/json/stations/search?countrycode=RU&order=clickcount&reverse=true&hidebroken=true&limit=900");
const seen = new Set();
const stations = [];
for (const s of raw) {
  const url = String(s.url_resolved || "");
  const name = String(s.name || "").replace(/\s+/g, " ").trim();
  if (!name || s.hls || s.lastcheckok === 0 || !/^https?:\/\//i.test(url)) continue;
  const key = name.toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);
  stations.push({
    id: s.stationuuid,
    name: name.slice(0, 120),
    url,
    codec: String(s.codec || ""),
    // Some list it in bit/s; FLAC is 1411 kbps for real.
    bitrate: kbps(Number(s.bitrate) || 0),
    country: String(s.countrycode || "RU"),
    tags: String(s.tags || "").split(",").map((t) => t.trim()).filter(Boolean).slice(0, 4).join(", "),
  });
  if (stations.length >= 400) break;
}
const out = fileURLToPath(new URL("../src/data/stations.json", import.meta.url));
writeFileSync(out, JSON.stringify(stations, null, 0).replace(/\},\{/g, "},\n{") + "\n");
console.log(`${stations.length} stations → ${out}`);
