// "Connection info" for calls: current latency, loss, jitter and traffic, a
// one-minute chart (latency or loss) with a hover readout, and the route the
// call takes. Opened from the voice panel and from the call itself.
import { useMemo, useState, type ReactNode } from "react";
import clsx from "clsx";
import { Signal, SignalHigh, SignalLow, SignalMedium, SignalZero } from "lucide-react";
import { t } from "../../lib/i18n";
import { voiceUrl } from "../../lib/server";
import { useData } from "../../store/data";
import { Segmented } from "../../components/ui/primitives";
import { Popover, usePopover } from "../../components/ui/overlay";
import { useVoice, type Quality } from "./voice";
import { WINDOW_MS, usePing, useCallStats, type CallSample } from "./stats";

// Status colors carry state only, always next to an icon and a label.
const QUALITY: Record<Quality, { icon: typeof Signal; tone: string }> = {
  excellent: { icon: Signal, tone: "text-ok" },
  good: { icon: SignalHigh, tone: "text-ok" },
  poor: { icon: SignalLow, tone: "text-warn" },
  lost: { icon: SignalZero, tone: "text-bad" },
  unknown: { icon: SignalMedium, tone: "text-fg-3" },
};

export function useMyQuality(): Quality {
  const me = useData((s) => s.me?.id);
  return useVoice((s) => (me && s.quality[me]) || "unknown");
}

type Metric = "ping" | "loss";
const pick = (s: CallSample, m: Metric) => (m === "ping" ? s.ping : s.loss);
const fmt = (v: number | null, m: Metric) => (v == null ? "—" : m === "ping" ? t("voice.stats.ms", { n: Math.round(v) }) : t("voice.stats.percent", { n: v < 10 ? v.toFixed(1).replace(/\.0$/, "") : Math.round(v) }));

/** Clean top of the y-axis: the smallest step that fits the data (and a floor, so a calm line stays calm). */
function niceMax(max: number, m: Metric) {
  const steps = m === "ping" ? [50, 100, 150, 200, 300, 500, 1000, 2000, 5000] : [2, 5, 10, 20, 50, 100];
  return steps.find((s) => s >= max * 1.1) ?? steps[steps.length - 1];
}

const W = 308;
const H = 112;
const PAD = { left: 30, right: 6, top: 8, bottom: 18 };

function Chart({ samples, metric }: { samples: CallSample[]; metric: Metric }) {
  const [hover, setHover] = useState<number | null>(null);
  const end = samples.at(-1)?.at ?? Date.now();
  const start = end - WINDOW_MS;
  const pts = samples.filter((s) => s.at >= start);
  const vals = pts.map((s) => pick(s, metric)).filter((v): v is number => v != null);
  const top = niceMax(Math.max(0, ...vals), metric);
  const pw = W - PAD.left - PAD.right;
  const ph = H - PAD.top - PAD.bottom;
  const x = (at: number) => PAD.left + ((at - start) / WINDOW_MS) * pw;
  const y = (v: number) => PAD.top + ph - (Math.min(v, top) / top) * ph;

  // Gaps in the data break the line instead of bridging them.
  const { line, area } = useMemo(() => {
    let line = "";
    let area = "";
    let run: [number, number][] = [];
    const flush = () => {
      if (!run.length) return;
      line += run.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`).join("");
      area += `M${run[0][0].toFixed(1)} ${PAD.top + ph}` + run.map(([px, py]) => `L${px.toFixed(1)} ${py.toFixed(1)}`).join("") + `L${run[run.length - 1][0].toFixed(1)} ${PAD.top + ph}Z`;
      run = [];
    };
    for (const s of pts) {
      const v = pick(s, metric);
      if (v == null) flush();
      else run.push([x(s.at), y(v)]);
    }
    flush();
    return { line, area };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pts, metric, top]);

  const last = [...pts].reverse().find((s) => pick(s, metric) != null);
  const h = hover != null ? pts[hover] : undefined;
  const hv = h ? pick(h, metric) : null;
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!pts.length) return;
    const r = e.currentTarget.getBoundingClientRect();
    const at = start + ((e.clientX - r.left) * (W / r.width) - PAD.left) / pw * WINDOW_MS;
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i].at - at) < Math.abs(pts[best].at - at)) best = i;
    setHover(best);
  };
  const ago = (at: number) => {
    const s = Math.round((end - at) / 1000);
    return s <= 1 ? t("voice.stats.now") : t("voice.stats.secondsAgo", { n: s });
  };

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-auto w-full touch-none select-none"
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={`${metric === "ping" ? t("voice.stats.chartPing") : t("voice.stats.chartLoss")}: ${fmt(last ? pick(last, metric) : null, metric)}`}
      >
        {[0, top / 2, top].map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="rgb(var(--line) / 0.1)" strokeWidth={1} />
            <text x={PAD.left - 6} y={y(v) + 3.5} textAnchor="end" className="fill-fg-3 text-[10px] tabular-nums">
              {v}
            </text>
          </g>
        ))}
        <text x={PAD.left} y={H - 4} className="fill-fg-3 text-[10px]">
          {t("voice.stats.minuteAgo")}
        </text>
        <text x={W - PAD.right} y={H - 4} textAnchor="end" className="fill-fg-3 text-[10px]">
          {t("voice.stats.now")}
        </text>
        <path d={area} fill="rgb(var(--star) / 0.1)" />
        <path d={line} fill="none" stroke="rgb(var(--star))" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {last && !h && <circle cx={x(last.at)} cy={y(pick(last, metric)!)} r={4} fill="rgb(var(--star))" stroke="rgb(var(--surface))" strokeWidth={2} />}
        {h && (
          <>
            <line x1={x(h.at)} x2={x(h.at)} y1={PAD.top} y2={PAD.top + ph} stroke="rgb(var(--fg-3) / 0.6)" strokeWidth={1} />
            {hv != null && <circle cx={x(h.at)} cy={y(hv)} r={4} fill="rgb(var(--star))" stroke="rgb(var(--surface))" strokeWidth={2} />}
          </>
        )}
      </svg>
      {h && (
        <div
          className="pointer-events-none absolute top-0 -translate-x-1/2 whitespace-nowrap rounded-lg bg-canvas px-2 py-1 text-[12px] shadow-lift hairline"
          style={{ left: `${(Math.min(Math.max(x(h.at), PAD.left + 40), W - 40) / W) * 100}%` }}
        >
          <span className="font-semibold text-fg">{fmt(hv, metric)}</span> <span className="text-fg-3">· {ago(h.at)}</span>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl bg-canvas/60 px-2.5 py-2">
      <div className="truncate text-[11.5px] font-semibold text-fg-3">{label}</div>
      <div className="mt-0.5 truncate text-[15px] font-semibold">{value}</div>
    </div>
  );
}

export function ConnectionStats() {
  const samples = useCallStats((s) => s.samples);
  const route = useCallStats((s) => s.route);
  const quality = useMyQuality();
  const server = useData((s) => s.server?.voice.url);
  const [metric, setMetric] = useState<Metric>("ping");
  const last = samples.at(-1);
  const series = samples.map((s) => pick(s, metric)).filter((v): v is number => v != null);
  const { icon: Icon, tone } = QUALITY[quality];
  const host = (() => {
    try {
      return new URL(voiceUrl(server)).host;
    } catch {
      return null;
    }
  })();
  const traffic = last?.upKbps != null || last?.downKbps != null ? `↑ ${last?.upKbps ?? "—"} · ↓ ${last?.downKbps ?? "—"}` : "—";

  return (
    <div className="w-[340px] max-w-[calc(100vw-16px)] rounded-2xl bg-surface p-4 shadow-lift hairline" data-connection-stats>
      <div className="font-display text-[15px] font-semibold">{t("voice.stats.title")}</div>
      <div className={clsx("mt-1 flex items-center gap-1.5 text-[12.5px] font-semibold", tone)}>
        <Icon size={15} />
        <span className="text-fg-2">{t(`voice.stats.${quality}`)}</span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Stat label={t("voice.stats.ping")} value={fmt(last?.ping ?? null, "ping")} />
        <Stat label={t("voice.stats.loss")} value={fmt(last?.loss ?? null, "loss")} />
        <Stat label={t("voice.stats.jitter")} value={last?.jitter != null ? t("voice.stats.ms", { n: last.jitter }) : "—"} />
        <Stat label={t("voice.stats.traffic")} value={<span className="tabular-nums">{traffic}</span>} />
      </div>

      <div className="mt-3">
        <Segmented<Metric>
          value={metric}
          onChange={setMetric}
          options={[
            { value: "ping", label: t("voice.stats.ping") },
            { value: "loss", label: t("voice.stats.loss") },
          ]}
        />
      </div>
      <div className="mt-2.5 text-[12px] font-semibold text-fg-3">{metric === "ping" ? t("voice.stats.chartPing") : t("voice.stats.chartLoss")}</div>
      <div className="mt-1">
        {series.length ? <Chart samples={samples} metric={metric} /> : <div className="flex h-[112px] items-center justify-center text-[13px] text-fg-3">{t("voice.stats.waiting")}</div>}
      </div>
      {series.length > 1 && (
        <div className="mt-1 text-center text-[11.5px] tabular-nums text-fg-3">
          {t("voice.stats.summary", {
            min: fmt(Math.min(...series), metric),
            avg: fmt(series.reduce((a, b) => a + b, 0) / series.length, metric),
            max: fmt(Math.max(...series), metric),
          })}
        </div>
      )}

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-line/10 pt-3 text-[12.5px]">
        <dt className="text-fg-3">{t("voice.stats.route")}</dt>
        <dd className="truncate text-fg-2">{route.type ? `${t(`voice.stats.${route.type}`)}${route.protocol ? ` · ${route.protocol}` : ""}` : "—"}</dd>
        <dt className="text-fg-3">{t("voice.stats.codec")}</dt>
        <dd className="truncate text-fg-2">{route.codec ? `${route.codec}${route.codecKhz ? ` · ${t("voice.stats.khz", { n: route.codecKhz })}` : ""}` : "—"}</dd>
        {host && (
          <>
            <dt className="text-fg-3">{t("voice.stats.server")}</dt>
            <dd className="truncate text-fg-2">{host}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

/**
 * Signal icon + live ping; opens the connection panel. Used in the voice panel
 * (sidebar) and on the call stage, where phones and DM calls show it.
 */
export function PingButton({ className, placement = "top-start", compact }: { className?: string; placement?: "top-start" | "bottom-start"; compact?: boolean }) {
  const pop = usePopover();
  const ping = usePing();
  const state = useVoice((s) => s.state);
  const quality = useMyQuality();
  const { icon: Icon, tone } = QUALITY[quality];
  return (
    <>
      <button
        onClick={pop.toggle}
        className={clsx("flex shrink-0 items-center gap-1 rounded-lg transition-colors hover:bg-raised", className)}
        aria-label={t("voice.stats.title")}
        title={t("voice.stats.title")}
      >
        <Icon size={compact ? 15 : 18} className={state === "connected" ? tone : "text-warn"} />
        {compact && ping != null && <span className="text-[12px] font-semibold tabular-nums text-fg-2">{t("voice.stats.ms", { n: ping })}</span>}
      </button>
      <Popover anchor={pop.anchor} onClose={pop.close} placement={placement}>
        <ConnectionStats />
      </Popover>
    </>
  );
}
