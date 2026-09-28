// Renders the Nova app icon (SVG) into every size the platforms need:
//   client/public/icon.png   — web favicon, tray, notifications (512)
//   client/build/icon.png    — Linux / generic (1024)
//   client/build/icon.ico    — Windows installer + taskbar (16…256)
//   client/assets/icon.png   — source for Android launcher icons (1024)
// Run: node scripts/make-icons.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { ICON_SVG } from "./brand.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(root, "server", "package.json"));
const sharp = require("sharp");

const svg = ICON_SVG;

const png = (size) => sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();

function ico(images) {
  // ICONDIR + ICONDIRENTRY[] + PNG payloads (PNG-in-ICO, supported since Vista).
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

const out = (p) => {
  const f = resolve(root, p);
  mkdirSync(dirname(f), { recursive: true });
  return f;
};

writeFileSync(out("client/public/icon.png"), await png(512));
writeFileSync(out("client/build/icon.png"), await png(1024));
writeFileSync(out("client/assets/icon.png"), await png(1024));
writeFileSync(out("docs/logo.svg"), svg.trim());
const sizes = [16, 24, 32, 48, 64, 128, 256];
writeFileSync(out("client/build/icon.ico"), ico(await Promise.all(sizes.map(async (size) => ({ size, data: await png(size) })))));
console.log("✅ icons written: client/public, client/build, client/assets, docs/logo.svg");
