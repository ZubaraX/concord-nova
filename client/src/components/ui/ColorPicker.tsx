// A full palette: saturation/brightness square, hue bar, hex field and optional
// presets. Used for the accent colour, a custom theme and profile colours.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import clsx from "clsx";
import { Popover, usePopover } from "./overlay";

type HSV = { h: number; s: number; v: number };

export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const rgbToHex = (r: number, g: number, b: number) => "#" + [r, g, b].map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("");

function rgbToHsv(r: number, g: number, b: number): HSV {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

function hsvToHex({ h, s, v }: HSV): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return rgbToHex(f(5) * 255, f(3) * 255, f(1) * 255);
}

/** Drag anywhere inside: reports the pointer position as 0..1 on both axes. */
function useDrag(onMove: (x: number, y: number) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const at = (e: ReactPointerEvent | PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    onMove(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)));
  };
  return {
    ref,
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      at(e);
    },
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) at(e);
    },
  };
}

export function ColorPicker({ value, onChange, presets }: { value: string; onChange: (hex: string) => void; presets?: string[] }) {
  // Hue and saturation live here: at black or grey they can't be read back from the hex.
  const [hsv, setHsv] = useState<HSV>(() => rgbToHsv(...(hexToRgb(value) ?? [255, 195, 92])));
  const [text, setText] = useState(value);
  useEffect(() => {
    setText(value);
    if (value.toLowerCase() !== hsvToHex(hsv)) {
      const rgb = hexToRgb(value);
      if (rgb) setHsv(rgbToHsv(...rgb));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const set = (next: HSV) => {
    setHsv(next);
    onChange(hsvToHex(next));
  };
  const sv = useDrag((x, y) => set({ ...hsv, s: x, v: 1 - y }));
  const hue = useDrag((x) => set({ ...hsv, h: x * 359.9 }));
  return (
    <div className="flex w-[232px] flex-col gap-3" data-color-picker>
      <div
        {...sv}
        className="relative h-[140px] cursor-crosshair touch-none rounded-xl"
        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h} 100% 50%))` }}
        role="slider"
        aria-label="saturation and brightness"
        aria-valuetext={hsvToHex(hsv)}
      >
        <span className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.5)]" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hsvToHex(hsv) }} />
      </div>
      <div
        {...hue}
        className="relative h-3.5 cursor-pointer touch-none rounded-full"
        style={{ background: "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)" }}
        role="slider"
        aria-label="hue"
        aria-valuenow={Math.round(hsv.h)}
        aria-valuemin={0}
        aria-valuemax={360}
      >
        <span className="pointer-events-none absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.5)]" style={{ left: `${(hsv.h / 360) * 100}%`, background: `hsl(${hsv.h} 100% 50%)` }} />
      </div>
      <div className="flex items-center gap-2">
        <span className="h-8 w-8 shrink-0 rounded-lg ring-1 ring-line/20" style={{ background: hsvToHex(hsv) }} />
        <input
          value={text}
          onChange={(e) => {
            const v = e.target.value.startsWith("#") ? e.target.value : `#${e.target.value}`;
            setText(v);
            const rgb = hexToRgb(v);
            if (rgb) {
              setHsv(rgbToHsv(...rgb));
              onChange(rgbToHex(...rgb));
            }
          }}
          maxLength={7}
          spellCheck={false}
          className="h-8 min-w-0 flex-1 rounded-lg bg-canvas/70 px-2.5 font-mono text-[13px] uppercase outline-none ring-1 ring-line/10 focus:ring-star/60"
          aria-label="HEX"
        />
      </div>
      {presets && (
        <div className="flex flex-wrap gap-1.5">
          {presets.map((c) => (
            <button key={c} onClick={() => onChange(c)} className={clsx("h-6 w-6 rounded-full ring-2 ring-offset-1 ring-offset-surface", value.toLowerCase() === c.toLowerCase() ? "ring-fg" : "ring-transparent")} style={{ background: c }} aria-label={c} />
          ))}
        </div>
      )}
    </div>
  );
}

/** A swatch that opens the palette. */
export function ColorButton({ value, onChange, presets, label, className }: { value: string; onChange: (hex: string) => void; presets?: string[]; label: string; className?: string }) {
  const pop = usePopover();
  return (
    <>
      <button
        onClick={pop.toggle}
        className={clsx("h-9 w-12 shrink-0 rounded-lg ring-1 ring-line/20 transition-transform hover:scale-105", className)}
        style={{ background: value }}
        aria-label={label}
        title={label}
      />
      <Popover anchor={pop.anchor} onClose={pop.close} placement="bottom-start">
        <div className="rounded-2xl bg-surface p-3 shadow-lift hairline">
          <ColorPicker value={value} onChange={onChange} presets={presets} />
        </div>
      </Popover>
    </>
  );
}
