import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cn } from '../lib/utils';

/**
 * Line and bar charts for any Zone (Reporting R1). Presentational only: values arrive as exact decimal
 * strings and are shown with the caller's `formatValue`; numbers are used for drawing, never for display
 * or arithmetic. Every chart is a <figure> with a caption, a legend that does not rely on colour (the
 * comparison series is dashed or hatched and labelled), and a visually hidden data table, so screen
 * readers and keyboard users get every value.
 */
export interface ChartSeries {
  key: string;
  label: string;
  /** One value per category; null means "not shown" (for example a suppressed small group). */
  values: (string | null)[];
  /** `comparison` draws the previous period: dashed line or lighter, outlined bars. */
  variant?: 'solid' | 'comparison';
  /** Series colour 1–5 (design tokens --chart-1 … --chart-5). Defaults to its position. */
  color?: 1 | 2 | 3 | 4 | 5;
}

export interface ChartProps {
  /** Accessible name and visible caption. */
  title: ReactNode;
  /** A short summary for assistive technology (for example "Amount invoiced per month, AUD"). */
  summary: string;
  /** Category labels along the x axis, already formatted (for example "Nov 2026"). */
  categories: string[];
  series: ChartSeries[];
  /** Exact value text for tooltips and the data table ("A$1,250.50"). */
  formatValue: (value: string) => string;
  /** Axis tick text from an approximate number ("A$1.2k"). */
  formatTick?: (value: number) => string;
  height?: number;
  className?: string;
}

const PAD = { top: 12, right: 12, bottom: 28, left: 56 };
const COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];
const colorOf = (s: ChartSeries, i: number) => (s.variant === 'comparison' ? 'var(--chart-comparison)' : COLORS[((s.color ?? i + 1) - 1) % COLORS.length]!);

/** Width of the element, following resizes where ResizeObserver exists (falls back to a fixed width). */
function useWidth(fallback = 640) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const w = Math.round(entry?.contentRect.width ?? 0);
      if (w > 0) setWidth(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Round axis bounds and 3–5 ticks ("nice numbers"). */
export function niceScale(min: number, max: number): { min: number; max: number; ticks: number[] } {
  const lo = Math.min(0, min);
  const hi = Math.max(0, max);
  if (hi === lo) return { min: 0, max: 1, ticks: [0, 1] };
  const raw = (hi - lo) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw)!;
  const nmin = Math.floor(lo / step) * step;
  const nmax = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let t = nmin; t <= nmax + step / 2; t += step) ticks.push(Number(t.toPrecision(12)));
  return { min: nmin, max: nmax, ticks };
}

const defaultTick = (v: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(v);

function Frame({ kind, props, children }: { kind: 'line' | 'bar'; props: ChartProps; children: (geo: Geometry) => ReactNode }) {
  const { title, summary, categories, series, formatValue, formatTick = defaultTick, height = 240, className } = props;
  const [ref, width] = useWidth();
  const captionId = useId();
  const numbers = series.flatMap((s) => s.values.filter((v): v is string => v !== null).map(Number)).filter(Number.isFinite);
  const scale = niceScale(numbers.length ? Math.min(...numbers) : 0, numbers.length ? Math.max(...numbers) : 0);
  const plotW = Math.max(40, width - PAD.left - PAD.right);
  const plotH = Math.max(40, height - PAD.top - PAD.bottom);
  const y = (v: number) => PAD.top + plotH - ((v - scale.min) / (scale.max - scale.min)) * plotH;
  const band = plotW / Math.max(1, categories.length);
  const x = (i: number) => (kind === 'bar' ? PAD.left + band * i + band / 2 : PAD.left + (categories.length <= 1 ? plotW / 2 : (plotW * i) / (categories.length - 1)));
  // Thin the x labels so they never overlap (about 72px each).
  const every = Math.max(1, Math.ceil(categories.length / Math.max(1, Math.floor(plotW / 72))));
  const geo: Geometry = { x, y, band, plotW, plotH, scale };
  return (
    <figure className={cn('rounded-xl border bg-card p-4', className)} aria-labelledby={captionId}>
      <figcaption id={captionId} className="mb-3 text-sm font-semibold text-card-foreground">{title}</figcaption>
      <div ref={ref} className="w-full">
        <svg role="img" aria-label={summary} width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block max-w-full overflow-visible">
          {scale.ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} stroke="var(--chart-grid)" strokeWidth={1} />
              <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[11px] tabular-nums">{formatTick(t)}</text>
            </g>
          ))}
          {categories.map((c, i) => (i % every === 0 ? (
            <text key={`${c}-${i}`} x={x(i)} y={height - 8} textAnchor="middle" className="fill-muted-foreground text-[11px]">{c}</text>
          ) : null))}
          {children(geo)}
        </svg>
      </div>
      {series.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legend">
          {series.map((s, i) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <svg aria-hidden="true" width="18" height="8">
                <line x1="1" x2="17" y1="4" y2="4" stroke={colorOf(s, i)} strokeWidth={3} strokeDasharray={s.variant === 'comparison' ? '4 3' : undefined} />
              </svg>
              {s.label}
            </li>
          ))}
        </ul>
      ) : null}
      {/* Wrapped: a table sizes to its content and would ignore sr-only's 1px width, widening the page. */}
      <div className="sr-only">
      <table>
        <caption>{summary}</caption>
        <thead>
          <tr><th scope="col">Period</th>{series.map((s) => <th key={s.key} scope="col">{s.label}</th>)}</tr>
        </thead>
        <tbody>
          {categories.map((c, i) => (
            <tr key={`${c}-${i}`}>
              <th scope="row">{c}</th>
              {series.map((s) => <td key={s.key}>{s.values[i] == null ? 'Not shown' : formatValue(s.values[i]!)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </figure>
  );
}

interface Geometry {
  x: (i: number) => number;
  y: (v: number) => number;
  band: number;
  plotW: number;
  plotH: number;
  scale: { min: number; max: number; ticks: number[] };
}

export function LineChart(props: ChartProps) {
  const { series, categories, formatValue } = props;
  return (
    <Frame kind="line" props={props}>
      {(g) => series.map((s, si) => {
        const color = colorOf(s, si);
        const points = s.values.map((v, i) => (v === null ? null : ([g.x(i), g.y(Number(v))] as const)));
        // Break the line at gaps (null values) instead of drawing through them.
        const segments: string[] = [];
        let current = '';
        points.forEach((p) => {
          if (!p) {
            if (current) segments.push(current);
            current = '';
          } else current += `${current ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`;
        });
        if (current) segments.push(current);
        return (
          <g key={s.key}>
            {segments.map((d, i) => (
              <path key={i} d={d} fill="none" stroke={color} strokeWidth={s.variant === 'comparison' ? 2 : 2.5} strokeDasharray={s.variant === 'comparison' ? '5 4' : undefined} strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {points.map((p, i) => (p ? (
              <circle key={i} cx={p[0]} cy={p[1]} r={categories.length > 40 ? 0 : 3} fill={s.variant === 'comparison' ? 'var(--card)' : color} stroke={color} strokeWidth={1.5}>
                <title>{`${s.label}, ${categories[i]}: ${formatValue(s.values[i]!)}`}</title>
              </circle>
            ) : null))}
          </g>
        );
      })}
    </Frame>
  );
}

export function BarChart(props: ChartProps) {
  const { series, categories, formatValue } = props;
  return (
    <Frame kind="bar" props={props}>
      {(g) => {
        const inner = Math.max(2, g.band * 0.72);
        const width = Math.max(1, inner / Math.max(1, series.length) - 2);
        const zero = g.y(Math.max(g.scale.min, Math.min(0, g.scale.max)));
        return series.map((s, si) => {
          const color = colorOf(s, si);
          return (
            <g key={s.key}>
              {s.values.map((v, i) => {
                if (v === null) return null;
                const top = g.y(Number(v));
                const left = g.x(i) - inner / 2 + si * (width + 2) + 1;
                return (
                  <rect key={i} x={left} width={width} y={Math.min(top, zero)} height={Math.max(1, Math.abs(zero - top))} rx={Math.min(3, width / 2)}
                    fill={s.variant === 'comparison' ? 'transparent' : color} stroke={color} strokeWidth={s.variant === 'comparison' ? 1.5 : 0}
                    strokeDasharray={s.variant === 'comparison' ? '3 2' : undefined}>
                    <title>{`${s.label}, ${categories[i]}: ${formatValue(v)}`}</title>
                  </rect>
                );
              })}
            </g>
          );
        });
      }}
    </Frame>
  );
}
