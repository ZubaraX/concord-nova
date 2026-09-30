// Cosmetics drawn in code (no image files): avatar decorations, and animated
// backdrops used both as profile effects and as chat wallpapers. Everything is
// SVG/CSS, follows the theme's accent where it makes sense, and stops moving
// when effects are turned off (see .fx-off in styles.css).
import { memo, useMemo, type CSSProperties, type ReactNode } from "react";
import clsx from "clsx";

// ── avatar decorations ───────────────────────────────────────────────────────
export const DECORATIONS = ["ring", "pulse", "orbit", "stars", "crown", "halo", "cat", "bunny", "horns", "headphones", "laurel", "flame", "hearts", "snow"] as const;
export type Decoration = (typeof DECORATIONS)[number];
export const isDecoration = (id: string | null | undefined): id is Decoration => !!id && (DECORATIONS as readonly string[]).includes(id);

const GOLD = "#ffcf5c";
const star = (cx: number, cy: number, r: number) => `M${cx} ${cy - r} L${cx + r * 0.28} ${cy - r * 0.28} L${cx + r} ${cy} L${cx + r * 0.28} ${cy + r * 0.28} L${cx} ${cy + r} L${cx - r * 0.28} ${cy + r * 0.28} L${cx - r} ${cy} L${cx - r * 0.28} ${cy - r * 0.28} Z`;
const heart = (cx: number, cy: number, s: number) =>
  `M${cx} ${cy + s * 0.9} C${cx - s * 1.6} ${cy - s * 0.2} ${cx - s * 0.8} ${cy - s * 1.2} ${cx} ${cy - s * 0.35} C${cx + s * 0.8} ${cy - s * 1.2} ${cx + s * 1.6} ${cy - s * 0.2} ${cx} ${cy + s * 0.9} Z`;

// Drawn in a 140×140 box: the avatar is the circle of radius 50 around (70, 70).
const DECOR: Record<Decoration, () => ReactNode> = {
  ring: () => (
    <>
      <defs>
        <linearGradient id="dc-ring" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="rgb(var(--star))" />
          <stop offset="0.5" stopColor="#ff6fb5" />
          <stop offset="1" stopColor="rgb(var(--sky))" />
        </linearGradient>
      </defs>
      <circle className="dc-spin" cx="70" cy="70" r="55" fill="none" stroke="url(#dc-ring)" strokeWidth="5" strokeLinecap="round" strokeDasharray="120 26" />
    </>
  ),
  pulse: () => (
    <>
      <circle className="dc-pulse" cx="70" cy="70" r="55" fill="none" stroke="rgb(var(--star))" strokeWidth="4" />
      <circle className="dc-pulse" style={{ animationDelay: "-1.1s" }} cx="70" cy="70" r="55" fill="none" stroke="rgb(var(--star))" strokeWidth="2" />
    </>
  ),
  orbit: () => (
    <>
      <circle cx="70" cy="70" r="58" fill="none" stroke="rgb(var(--sky))" strokeOpacity="0.3" strokeWidth="1.5" />
      <g className="dc-spin">
        <circle cx="70" cy="12" r="5.5" fill="rgb(var(--star))" />
        <circle cx="70" cy="128" r="3.5" fill="rgb(var(--sky))" />
      </g>
    </>
  ),
  stars: () => (
    <>
      {[
        [22, 26, 9, 0],
        [120, 36, 7, -0.7],
        [116, 112, 9, -1.3],
        [20, 104, 6, -1.9],
      ].map(([x, y, r, d], i) => (
        <path key={i} className="dc-twinkle" style={{ animationDelay: `${d}s` }} d={star(x, y, r)} fill={GOLD} />
      ))}
    </>
  ),
  crown: () => (
    <g transform="rotate(-10 70 70)">
      <path d="M44 34 L40 8 L56 20 L70 2 L84 20 L100 8 L96 34 Z" fill={GOLD} stroke="#c98a12" strokeWidth="2" strokeLinejoin="round" />
      <circle cx="70" cy="9" r="3.4" fill="#ff5c7a" />
      <circle cx="42" cy="12" r="2.6" fill="#7dc8ff" />
      <circle cx="98" cy="12" r="2.6" fill="#7dc8ff" />
    </g>
  ),
  halo: () => (
    <g className="dc-float">
      <ellipse cx="70" cy="13" rx="28" ry="7.5" fill="none" stroke={GOLD} strokeWidth="5" style={{ filter: "drop-shadow(0 0 5px #ffcf5c)" }} />
    </g>
  ),
  cat: () => (
    <>
      <path d="M20 50 L26 8 L58 26 Z" fill="#f0a35a" stroke="#b8702a" strokeWidth="2" strokeLinejoin="round" />
      <path d="M28 40 L31 20 L46 29 Z" fill="#ffc9d6" />
      <path d="M120 50 L114 8 L82 26 Z" fill="#f0a35a" stroke="#b8702a" strokeWidth="2" strokeLinejoin="round" />
      <path d="M112 40 L109 20 L94 29 Z" fill="#ffc9d6" />
    </>
  ),
  bunny: () => (
    <>
      <g transform="rotate(-14 50 30)">
        <ellipse cx="50" cy="16" rx="9" ry="24" fill="#f4f1f7" stroke="#c9c2d6" strokeWidth="2" />
        <ellipse cx="50" cy="17" rx="4" ry="16" fill="#ffc1d5" />
      </g>
      <g transform="rotate(14 90 30)">
        <ellipse cx="90" cy="16" rx="9" ry="24" fill="#f4f1f7" stroke="#c9c2d6" strokeWidth="2" />
        <ellipse cx="90" cy="17" rx="4" ry="16" fill="#ffc1d5" />
      </g>
    </>
  ),
  horns: () => (
    <>
      <path d="M36 38 C18 34 14 16 22 4 C26 20 36 24 48 28 Z" fill="#e3364e" stroke="#8e1527" strokeWidth="2" strokeLinejoin="round" />
      <path d="M104 38 C122 34 126 16 118 4 C114 20 104 24 92 28 Z" fill="#e3364e" stroke="#8e1527" strokeWidth="2" strokeLinejoin="round" />
    </>
  ),
  headphones: () => (
    <>
      <path d="M17 76 A53 53 0 0 1 123 76" fill="none" stroke="#2b2f45" strokeWidth="7" strokeLinecap="round" />
      <path d="M17 76 A53 53 0 0 1 123 76" fill="none" stroke="rgb(var(--star))" strokeWidth="2" strokeLinecap="round" />
      <rect x="6" y="62" width="17" height="32" rx="7" fill="#2b2f45" stroke="rgb(var(--star))" strokeWidth="2" />
      <rect x="117" y="62" width="17" height="32" rx="7" fill="#2b2f45" stroke="rgb(var(--star))" strokeWidth="2" />
    </>
  ),
  laurel: () => (
    <>
      {Array.from({ length: 7 }, (_, i) => {
        const a = ((108 + i * 17) * Math.PI) / 180; // down the left side
        const x = 70 + Math.cos(a) * 59;
        const y = 70 + Math.sin(a) * 59;
        const rot = (a * 180) / Math.PI + 60;
        return (
          <g key={i}>
            <ellipse cx={x} cy={y} rx="9" ry="4" transform={`rotate(${rot} ${x} ${y})`} fill="#e7b93f" stroke="#a87c12" strokeWidth="1" />
            <ellipse cx={140 - x} cy={y} rx="9" ry="4" transform={`rotate(${180 - rot} ${140 - x} ${y})`} fill="#e7b93f" stroke="#a87c12" strokeWidth="1" />
          </g>
        );
      })}
    </>
  ),
  flame: () => (
    <>
      <defs>
        <linearGradient id="dc-flame" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#ff3d2e" />
          <stop offset="0.6" stopColor="#ff9a2e" />
          <stop offset="1" stopColor="#ffe08a" />
        </linearGradient>
      </defs>
      <circle cx="70" cy="70" r="55" fill="none" stroke="url(#dc-flame)" strokeWidth="5" />
      {[
        [70, 14, 1, 0],
        [44, 24, 0.75, -0.4],
        [96, 24, 0.75, -0.8],
        [26, 44, 0.55, -0.2],
        [114, 44, 0.55, -0.6],
      ].map(([x, y, s, d], i) => (
        <path key={i} className="dc-flicker" style={{ animationDelay: `${d}s`, transformOrigin: `${x}px ${y + 8}px` }} d={`M${x} ${y - 16 * s} C${x + 9 * s} ${y - 4 * s} ${x + 8 * s} ${y + 6 * s} ${x} ${y + 9 * s} C${x - 8 * s} ${y + 6 * s} ${x - 9 * s} ${y - 4 * s} ${x} ${y - 16 * s} Z`} fill="url(#dc-flame)" />
      ))}
    </>
  ),
  hearts: () => (
    <>
      {[
        [18, 96, 7, 0],
        [124, 84, 6, -1.2],
        [30, 30, 5, -2.1],
        [112, 26, 7, -0.6],
      ].map(([x, y, s, d], i) => (
        <path key={i} className="dc-rise" style={{ animationDelay: `${d}s` }} d={heart(x, y, s)} fill="#ff5c8a" />
      ))}
    </>
  ),
  snow: () => (
    <>
      {[
        [16, 20, 3, 0],
        [40, 6, 2.2, -1.4],
        [100, 8, 2.8, -0.7],
        [126, 30, 2.2, -2.2],
        [130, 78, 3, -1.1],
        [10, 70, 2.4, -2.8],
      ].map(([x, y, r, d], i) => (
        <circle key={i} className="dc-fall" style={{ animationDelay: `${d}s` }} cx={x} cy={y} r={r} fill="#e9f4ff" />
      ))}
    </>
  ),
};

/** Drawn around an avatar of `size` px (it reaches 20% beyond it on every side). */
export const AvatarDecoration = memo(function AvatarDecoration({ id, size }: { id: string | null | undefined; size: number }) {
  if (!isDecoration(id) || size < 24) return null;
  const pad = size * 0.2;
  return (
    <svg className="decor pointer-events-none absolute z-[1]" style={{ left: -pad, top: -pad, width: size + pad * 2, height: size + pad * 2, overflow: "visible" }} viewBox="0 0 140 140" aria-hidden>
      {DECOR[id]()}
    </svg>
  );
});

// ── animated backdrops (profile effects, chat wallpapers) ────────────────────
export const BACKDROPS = ["waves", "stars", "aurora", "snow", "hearts", "fireflies", "rain", "bubbles", "gradient"] as const;
export type BackdropKind = (typeof BACKDROPS)[number];
export const isBackdrop = (id: string | null | undefined): id is BackdropKind => !!id && (BACKDROPS as readonly string[]).includes(id);

/** Same layout every render (and on every device): a tiny seeded generator. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function particles(n: number, seed: number, make: (r: () => number, i: number) => { style: CSSProperties; className: string; content?: ReactNode }) {
  const r = seeded(seed);
  return Array.from({ length: n }, (_, i) => {
    const p = make(r, i);
    return (
      <span key={i} className={clsx("absolute block", p.className)} style={p.style}>
        {p.content}
      </span>
    );
  });
}

const WAVE = "M0 40 C 120 10 240 70 360 40 S 600 10 720 40 S 960 70 1080 40 S 1320 10 1440 40 V 120 H 0 Z";

function render(kind: BackdropKind): ReactNode {
  switch (kind) {
    case "waves":
      return [0.14, 0.2, 0.28].map((o, i) => (
        <svg key={i} className="bd-wave absolute bottom-0 left-0 h-[32%] w-[200%]" style={{ animationDuration: `${14 - i * 3.5}s`, animationDirection: i % 2 ? "reverse" : "normal", opacity: o, bottom: `${-i * 6}%` }} viewBox="0 0 1440 120" preserveAspectRatio="none">
          <path d={WAVE} fill={i === 1 ? "rgb(var(--sky))" : "rgb(var(--star))"} />
        </svg>
      ));
    case "stars":
      return particles(46, 11, (r) => {
        const s = 1 + r() * 2.4;
        return { className: "bd-twinkle rounded-full bg-white", style: { left: `${r() * 100}%`, top: `${r() * 100}%`, width: s, height: s, animationDelay: `${-r() * 4}s`, animationDuration: `${2.4 + r() * 3}s` } };
      });
    case "aurora":
      return [
        ["rgb(var(--star))", "10%", "12%", 0],
        ["rgb(var(--sky))", "48%", "30%", -6],
        ["#c05cff", "72%", "8%", -11],
      ].map(([c, l, t, d], i) => (
        <span key={i} className="bd-drift absolute block h-[70%] w-[55%] rounded-full" style={{ left: l as string, top: t as string, background: c as string, opacity: 0.22, filter: "blur(48px)", animationDelay: `${d}s` }} />
      ));
    case "snow":
      return particles(34, 23, (r) => {
        const s = 2 + r() * 4;
        return { className: "bd-fall rounded-full bg-white", style: { left: `${r() * 100}%`, top: "-4%", width: s, height: s, opacity: 0.35 + r() * 0.5, animationDelay: `${-r() * 12}s`, animationDuration: `${7 + r() * 8}s` } };
      });
    case "hearts":
      return particles(14, 37, (r) => {
        const s = 10 + r() * 14;
        return {
          className: "bd-rise",
          style: { left: `${r() * 96}%`, bottom: "-8%", width: s, height: s, opacity: 0.55, animationDelay: `${-r() * 10}s`, animationDuration: `${8 + r() * 7}s` },
          content: (
            <svg viewBox="0 0 24 24" className="h-full w-full">
              <path d={heart(12, 12, 7)} fill="#ff5c8a" />
            </svg>
          ),
        };
      });
    case "fireflies":
      return particles(20, 53, (r) => {
        const s = 3 + r() * 3;
        return { className: "bd-firefly rounded-full", style: { left: `${r() * 96}%`, top: `${r() * 92}%`, width: s, height: s, background: "rgb(var(--star))", boxShadow: "0 0 10px 2px rgb(var(--star) / 0.7)", animationDelay: `${-r() * 8}s`, animationDuration: `${6 + r() * 6}s` } };
      });
    case "rain":
      return particles(44, 71, (r) => ({ className: "bd-rain", style: { left: `${r() * 104 - 2}%`, top: "-12%", width: 1.5, height: `${8 + r() * 10}%`, background: "linear-gradient(transparent, rgb(var(--sky) / 0.75))", animationDelay: `${-r() * 2}s`, animationDuration: `${0.7 + r() * 0.7}s` } }));
    case "bubbles":
      return particles(18, 89, (r) => {
        const s = 10 + r() * 34;
        return { className: "bd-rise rounded-full", style: { left: `${r() * 94}%`, bottom: "-12%", width: s, height: s, border: "1.5px solid rgb(var(--sky) / 0.55)", background: "rgb(var(--sky) / 0.08)", animationDelay: `${-r() * 12}s`, animationDuration: `${9 + r() * 9}s` } };
      });
    case "gradient":
      return <span className="bd-flow absolute inset-0 block" style={{ background: "linear-gradient(120deg, rgb(var(--star) / 0.30), rgb(var(--sky) / 0.26), #c05cff44, rgb(var(--star) / 0.30))", backgroundSize: "300% 300%" }} />;
  }
}

/** Fills its (relative) parent; never takes pointer events. */
export const Backdrop = memo(function Backdrop({ kind, className, style }: { kind: string | null | undefined; className?: string; style?: CSSProperties }) {
  const body = useMemo(() => (isBackdrop(kind) ? render(kind) : null), [kind]);
  if (!body) return null;
  return (
    <div className={clsx("backdrop pointer-events-none absolute inset-0 overflow-hidden", className)} style={style} data-backdrop={kind} aria-hidden>
      {body}
    </div>
  );
});
