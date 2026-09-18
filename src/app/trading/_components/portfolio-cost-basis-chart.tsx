"use client";

import { agorot, formatAgorot } from "../../../lib/money";
import type { CostBasisByDatePoint } from "../../../lib/holding-lots";
import { LightweightChart, type AreaSeriesSpec } from "../../../components/charts/lightweight-chart";

/**
 * Open cost basis by acquisition date — see `buildCumulativeCostBasisByDate`'s
 * own doc comment for exactly what this is (and isn't: not a true
 * historical reconstruction, since `HoldingLot` rows mutate in place).
 * An area series, per the Phase 2 "feed HoldingLot data using
 * addAreaSeries" ask — there's no OHLC shape here to candlestick.
 */
export function PortfolioCostBasisChart({ points }: { points: CostBasisByDatePoint[] }) {
  if (points.length === 0) {
    return <p className="text-sm text-muted">No open lots yet — nothing to chart.</p>;
  }

  const series: AreaSeriesSpec[] = [
    {
      type: "area",
      data: points.map((point) => ({ time: point.dateKey, value: Number(point.cumulativeCostBasisAgorot) })),
    },
  ];

  return (
    <LightweightChart
      series={series}
      priceFormatter={(value) => formatAgorot(agorot(Math.round(value)))}
    />
  );
}
