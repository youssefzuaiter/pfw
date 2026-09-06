"use client";

import { agorot, formatAgorot } from "../../../lib/money";
import { LightweightChart, type CandlestickSeriesSpec } from "../../../components/charts/lightweight-chart";

/**
 * The trading desk's price chart (Phase 2, ad hoc) — migrated from a
 * Recharts SVG `<Area>` chart to `lightweight-charts`' canvas-rendered
 * candlesticks. This is the one Recharts chart `/trading` ever actually
 * had (confirmed by grep before touching anything — `/trading/portfolio`
 * has none); the OHLC shape it now renders comes from
 * `getMockPriceBarHistory` (new — see `mock-market-data.ts`'s own doc
 * comment), not from `ScenarioMetrics`/`HoldingLot`, neither of which
 * carries open/high/low/close data to candlestick from.
 */
export function PriceChart({ bars }: { bars: readonly { date: Date; open: number; high: number; low: number; close: number }[] }) {
  if (bars.length === 0) {
    return <p className="text-sm text-muted">No price history available.</p>;
  }

  const series: CandlestickSeriesSpec[] = [
    {
      type: "candlestick",
      data: bars.map((bar) => ({
        time: bar.date.toISOString().slice(0, 10),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      })),
    },
  ];

  return (
    <LightweightChart series={series} height={224} priceFormatter={(value) => formatAgorot(agorot(Math.round(value)))} />
  );
}
