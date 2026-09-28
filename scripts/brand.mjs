// Nova brand artwork shared by the icon generators (scripts/make-icons.mjs,
// client/scripts/android-prepare.mjs).
export const BG = "#0b0d1a";
export const ADAPTIVE_BG = "#14172e";
export const STAR_PATH = "M50 4 C53.5 36 64 46.5 96 50 C64 53.5 53.5 64 50 96 C46.5 64 36 53.5 4 50 C36 46.5 46.5 36 50 4Z";

const defs = `
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#ffc35c" stop-opacity="0.55"/>
      <stop offset="0.55" stop-color="#ff9248" stop-opacity="0.12"/>
      <stop offset="1" stop-color="#ff9248" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="star" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffd98a"/>
      <stop offset="0.5" stop-color="#ffc35c"/>
      <stop offset="1" stop-color="#ff9248"/>
    </linearGradient>`;

/** Star + glow centered in a 1024 box; `scale` sizes the star (7.2 = full icon). */
const star = (scale, glowR) => `
  <circle cx="512" cy="512" r="${glowR}" fill="url(#glow)"/>
  <path transform="translate(512 512) scale(${scale}) translate(-50 -50)" d="${STAR_PATH}" fill="url(#star)"/>
  <circle cx="512" cy="512" r="${Math.round(scale * 4.2)}" fill="#fffaeb"/>`;

/** Full app icon: rounded dark tile, glow, sparkles and the star. */
export const ICON_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1b1f3d"/>
      <stop offset="1" stop-color="#0b0d1a"/>
    </linearGradient>${defs}
  </defs>
  <rect width="1024" height="1024" rx="230" fill="url(#bg)"/>
  <circle cx="250" cy="240" r="7" fill="#e7e9f5" opacity="0.7"/>
  <circle cx="790" cy="300" r="5" fill="#e7e9f5" opacity="0.55"/>
  <circle cx="300" cy="800" r="5" fill="#e7e9f5" opacity="0.5"/>
  <circle cx="820" cy="760" r="8" fill="#ffc35c" opacity="0.7"/>${star(7.2, 430)}
</svg>`.trim();

/** Transparent star for Android adaptive-icon foregrounds / splash (fits the 66/108 safe zone). */
export const STAR_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>${defs}
  </defs>${star(4.6, 300)}
</svg>`.trim();
