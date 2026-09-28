// Generates client/src/lib/emoji/data.json from emojibase-data: every emoji
// with its group, shortcodes (github-style :smile:) and search keywords in
// Russian + English, plus skin-tone variants. Run: node scripts/build-emoji.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = dirname(require.resolve("emojibase-data/package.json", { paths: [resolve(root, "client")] }));
const load = (p) => JSON.parse(readFileSync(resolve(base, p), "utf8"));

const ru = load("ru/compact.json");
const en = new Map(load("en/compact.json").map((e) => [e.hexcode, e]));
const github = load("en/shortcodes/github.json");
const cldr = load("en/shortcodes/cldr.json");
const ruCodes = load("ru/shortcodes/cldr.json");

const list = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const out = [];
for (const e of ru) {
  if (e.group === undefined || e.group === 2) continue; // skip components (skin tones, hair)
  const eng = en.get(e.hexcode);
  const codes = [...new Set([...list(github[e.hexcode]), ...list(cldr[e.hexcode])])].map((s) => s.toLowerCase());
  const words = new Set(
    [e.label, ...(e.tags ?? []), eng?.label, ...(eng?.tags ?? []), ...list(ruCodes[e.hexcode])]
      .filter(Boolean)
      .map((s) => String(s).toLowerCase().replace(/ё/g, "е").replace(/_/g, " "))
  );
  const row = [e.unicode, e.group, codes.join(" "), [...words].join("|"), e.order ?? 99999];
  if (e.skins?.length) row.push(e.skins.slice(0, 5).map((s) => s.unicode));
  out.push(row);
}
out.sort((a, b) => a[4] - b[4]);
const data = out.map((r) => (r.length > 5 ? [r[0], r[1], r[2], r[3], r[5]] : [r[0], r[1], r[2], r[3]]));
const dest = resolve(root, "client/src/lib/emoji/data.json");
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, JSON.stringify(data));
console.log(`emoji: ${data.length} entries → ${dest}`);
