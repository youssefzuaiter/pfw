"use client";

import { AreaSeries, CandlestickSeries, ColorType, createChart, type IChartApi, type Time } from "lightweight-charts";
import { useEffect, useRef } from "react";

// CSS named colors, not hex literals — this repo's own guard test
// (tests/guards/no-untokenized-hex.test.ts) forbids hex literals outside
// globals.css, same reasoning `particle-field.tsx`'s own
// `TOKEN_FALLBACKS` already documents (§3f) — these only ever apply if a
// --pfw-* token is somehow missing at read time (it never is;
// globals.css defines all five unconditionally on :root).
const TOKEN_FALLBACKS = {
  "--pfw-accent": "dodgerblue",
  "--pfw-positive": "seagreen",
  "--pfw-negative": "indianred",
  "--pfw-border": "dimgray",
  "--pfw-muted": "darkgray",
} as const;

export type AreaSeriesSpec = {
  type: "area";
  data: { time: Time; value: number }[];
};

export type CandlestickSeriesSpec = {
  type: "candlestick";
  data: { time: Time; open: number; high: number; low: number; close: number }[];
};

export type LightweightChartSeries = AreaSeriesSpec | CandlestickSeriesSpec;

type LightweightChartProps = {
  series: LightweightChartSeries[];
  height?: number;
  /** Formats a raw y-axis value into display text — e.g. `formatAgorot` for a money series, or a `%` suffix for a predicted-move series. Defaults to the value's own string form. */
  priceFormatter?: (value: number) => string;
};

/**
 * Generic TradingView `lightweight-charts` wrapper (Phase 2, ad hoc) —
 * replaces the one Recharts SVG chart this app ever had in `/trading`
 * (`price-chart.tsx`, on the desk page) and backs the two new area-series
 * charts this same pass adds (portfolio cost-basis, agent predicted
 * move). One wrapper, reused three ways, rather than three separate
 * `createChart` call sites.
 *
 * Colors are read LIVE via `getComputedStyle`, never a hardcoded hex —
 * the same reasoning `particle-field.tsx`'s own doc comment gives for the
 * R3F hero (§3f): a `<canvas>`-rendered library needs real color VALUES,
 * not Tailwind classes, and `no-untokenized-hex.test.ts` only ever scans
 * source for a literal hex string, never a runtime-computed one. This
 * app's `--pfw-accent`/`--pfw-positive`/`--pfw-negative`/`--pfw-border`/
 * `--pfw-muted` tokens are currently IDENTICAL across light/dark/navy —
 * verified by reading `globals.css` directly before relying on this,
 * not assumed — so reading them once at mount looks correct regardless
 * of the surrounding shell's own theme state, including `/trading`'s own
 * fixed-dark shell (`src/app/trading/layout.tsx`), which never emits a
 * light-mode `:root` override at all.
 */
export function LightweightChart({ series, height = 224, priceFormatter }: LightweightChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const rootStyle = getComputedStyle(document.documentElement);
    const accent = rootStyle.getPropertyValue("--pfw-accent").trim() || TOKEN_FALLBACKS["--pfw-accent"];
    const positive = rootStyle.getPropertyValue("--pfw-positive").trim() || TOKEN_FALLBACKS["--pfw-positive"];
    const negative = rootStyle.getPropertyValue("--pfw-negative").trim() || TOKEN_FALLBACKS["--pfw-negative"];
    const border = rootStyle.getPropertyValue("--pfw-border").trim() || TOKEN_FALLBACKS["--pfw-border"];
    const muted = rootStyle.getPropertyValue("--pfw-muted").trim() || TOKEN_FALLBACKS["--pfw-muted"];

    const chart: IChartApi = createChart(container, {
      width: container.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: muted,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: border },
      },
      rightPriceScale: { borderColor: border },
      timeScale: { borderColor: border },
      crosshair: { vertLine: { color: muted }, horzLine: { color: muted } },
      localization: priceFormatter ? { priceFormatter } : undefined,
    });

    for (const spec of series) {
      if (spec.type === "candlestick") {
        const candlestickSeries = chart.addSeries(CandlestickSeries, {
          upColor: positive,
          downColor: negative,
          borderVisible: false,
          wickUpColor: positive,
          wickDownColor: negative,
        });
        candlestickSeries.setData(spec.data);
      } else {
        // The alpha-suffix trick only works for a genuine `#rrggbb` hex
        // string (always true for the real `--pfw-accent` token today) —
        // guarded so the never-really-hit named-color fallback still
        // produces a valid (just non-transparent) fill instead of an
        // invalid CSS color string like `dodgerblue40`.
        const isHex = accent.startsWith("#") && accent.length === 7;
        const areaSeries = chart.addSeries(AreaSeries, {
          lineColor: accent,
          topColor: isHex ? `${accent}40` : accent,
          bottomColor: isHex ? `${accent}00` : "transparent",
        });
        areaSeries.setData(spec.data);
      }
    }

    chart.timeScale().fitContent();

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      chart.resize(entry.contentRect.width, height);
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
    };
    // A new `series`/`priceFormatter` identity on every render means a
    // full `createChart`/destroy cycle each time — matches this app's
    // existing Recharts charts, which also re-rendered freely, and
    // `createChart`'s own cost is small enough at this app's data
    // volumes not to warrant a custom equality check or memoized props.
  }, [series, height, priceFormatter]);

  return <div ref={containerRef} className="w-full" />;
}
