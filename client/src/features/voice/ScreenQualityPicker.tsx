// Picking the screen-share quality: a ladder of presets from economical to
// extreme, each with what it is for, plus "Custom" with every knob. Used in
// settings (full) and when starting a share (compact).
import clsx from "clsx";
import { t } from "../../lib/i18n";
import { settings, useSettings } from "../../store/settings";
import { Segmented, Slider } from "../../components/ui/primitives";
import { DEFAULT_SCREEN_CUSTOM, SCREEN_PRESETS, SCREEN_PRESET_IDS, normalizeScreenQuality, resolveScreenPreset, supportedCodecs, type ScreenCodec, type ScreenMode, type ScreenPreset } from "./screenQuality";

export const fmtBitrate = (bps: number) => (bps >= 1_000_000 ? t("screen.mbps", { n: +(bps / 1_000_000).toFixed(bps < 10_000_000 ? 1 : 0) }) : t("screen.kbps", { n: Math.round(bps / 1000) }));

/** "1080p · 60 к/с · 10 Мбит/с · H.264" */
export function presetSpecs(p: ScreenPreset): string {
  return [p.height ? `${p.height}p` : t("screen.source"), `${p.fps} ${t("screen.fps")}`, fmtBitrate(p.bitrate), CODEC_NAMES[p.codec]].join(" · ");
}

const CODEC_NAMES: Record<ScreenCodec, string> = { h264: "H.264", vp9: "VP9", av1: "AV1" };

export function ScreenQualityPicker({ compact }: { compact?: boolean }) {
  const quality = useSettings((s) => normalizeScreenQuality(s.screenQuality));
  const codec = useSettings((s) => s.screenCodec ?? "auto");
  const stored = useSettings((s) => s.screenCustom);
  const custom = { ...DEFAULT_SCREEN_CUSTOM, ...stored };
  const codecs = supportedCodecs();
  const setCustom = (p: Partial<typeof custom>) => settings().setLocal({ screenCustom: { ...custom, ...p } });

  return (
    <div className="flex flex-col gap-1.5" data-screen-quality>
      <div role="radiogroup" aria-label={t("settings.screenQuality")} className={clsx("grid gap-1.5", compact ? "grid-cols-2" : "sm:grid-cols-2")}>
        {[...SCREEN_PRESET_IDS, "custom" as const].map((id) => {
          const p = id === "custom" ? resolveScreenPreset("custom", custom, "auto") : { ...SCREEN_PRESETS[id], codec: resolveScreenPreset(id, undefined, codec).codec };
          const on = quality === id;
          return (
            <button
              key={id}
              role="radio"
              aria-checked={on}
              data-preset={id}
              onClick={() => settings().setLocal({ screenQuality: id })}
              className={clsx("rounded-xl px-3 py-2 text-left ring-1 transition-colors", on ? "bg-star/12 ring-star/60" : "bg-canvas/50 ring-line/10 hover:bg-raised")}
            >
              <div className="flex items-center gap-2">
                <span className="truncate text-[13.5px] font-semibold">{t(`screen.preset.${id}`)}</span>
              </div>
              <div className="truncate text-[11.5px] font-medium tabular-nums text-fg-3">{presetSpecs(p)}</div>
              {!compact && <div className="mt-0.5 text-[12px] leading-snug text-fg-3">{t(`screen.presetHint.${id}`)}</div>}
            </button>
          );
        })}
      </div>

      {quality === "custom" ? (
        <div className="mt-1 flex flex-col gap-3 rounded-xl bg-canvas/50 p-3 ring-1 ring-line/10" data-screen-custom>
          <Row label={t("screen.resolution")}>
            <Segmented
              value={String(custom.height)}
              options={[720, 1080, 1440, 2160, 0].map((h) => ({ value: String(h), label: h ? `${h}p` : t("screen.source") }))}
              onChange={(v) => setCustom({ height: Number(v) })}
            />
          </Row>
          <Row label={t("screen.framerate")}>
            <Segmented value={String(custom.fps)} options={[15, 30, 60].map((f) => ({ value: String(f), label: `${f} ${t("screen.fps")}` }))} onChange={(v) => setCustom({ fps: Number(v) })} />
          </Row>
          <Row label={t("screen.bitrate")}>
            <Slider value={custom.bitrateKbps / 1000} min={1} max={50} step={0.5} onChange={(v) => setCustom({ bitrateKbps: Math.round(v * 1000) })} format={(v) => fmtBitrate(v * 1_000_000)} className="min-w-0 flex-1" />
          </Row>
          <Row label={t("screen.priority")}>
            <Segmented
              value={custom.mode}
              options={(["detail", "balanced", "motion"] as ScreenMode[]).map((m) => ({ value: m, label: t(`screen.mode.${m}`) }))}
              onChange={(v) => setCustom({ mode: v })}
            />
          </Row>
          <Row label={t("screen.codec")}>
            <Segmented value={custom.codec} options={codecs.map((c) => ({ value: c, label: CODEC_NAMES[c] }))} onChange={(v) => setCustom({ codec: v })} />
          </Row>
          <p className="text-[12px] leading-snug text-fg-3">{t(`screen.codecHint.${custom.codec}`)}</p>
        </div>
      ) : (
        codecs.length > 1 && (
          <div className="mt-1 flex flex-col gap-1.5">
            <Row label={t("screen.codec")}>
              <Segmented
                value={codec}
                options={[{ value: "auto" as const, label: t("screen.codecAuto") }, ...codecs.map((c) => ({ value: c, label: CODEC_NAMES[c] }))]}
                onChange={(v) => settings().setLocal({ screenCodec: v })}
              />
            </Row>
            {!compact && <p className="text-[12px] leading-snug text-fg-3">{t(`screen.codecHint.${codec === "auto" ? "h264" : codec}`)}</p>}
          </div>
        )
      )}
      {!compact && <p className="text-[12px] leading-snug text-fg-3">{t("screen.liveHint")}</p>}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="w-[104px] shrink-0 text-[12.5px] font-semibold text-fg-3">{label}</span>
      {children}
    </div>
  );
}
