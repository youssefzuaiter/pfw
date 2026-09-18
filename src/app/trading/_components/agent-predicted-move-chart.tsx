"use client";

import type { UTCTimestamp } from "lightweight-charts";
import { LightweightChart, type AreaSeriesSpec } from "../../../components/charts/lightweight-chart";

type ScenarioMetricRow = { createdAt: Date; predictedMovePct: number };

/**
 * The agent's predicted-move-% history — an area series, per the Phase 2
 * "feed ScenarioMetrics data using addAreaSeries" ask. Unlike the
 * portfolio's cost-basis chart, this one needs no caveat: `ScenarioMetrics`
 * rows are write-once telemetry (never mutated after insert — see this
 * table's own schema doc comment), so plotting `predictedMovePct` by
 * `createdAt` really is a genuine historical time series.
 *
 * `lightweight-charts` requires STRICTLY ascending, non-duplicate `time`
 * values within one series — the agent can evaluate more than one
 * scenario within the same second, so same-second rows are nudged
 * forward by whole seconds here rather than dropped, keeping every row
 * visible without violating that requirement.
 */
function toStrictlyAscendingSeconds(rows: readonly ScenarioMetricRow[]): { time: UTCTimestamp; value: number }[] {
  let previousSeconds = -Infinity;
  return rows.map((row) => {
    const seconds = Math.max(Math.floor(row.createdAt.getTime() / 1000), previousSeconds + 1);
    previousSeconds = seconds;
    return { time: seconds as UTCTimestamp, value: row.predictedMovePct };
  });
}

export function AgentPredictedMoveChart({ rows }: { rows: ScenarioMetricRow[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted">No evaluated scenarios yet — nothing to chart.</p>;
  }

  const series: AreaSeriesSpec[] = [{ type: "area", data: toStrictlyAscendingSeconds(rows) }];

  return <LightweightChart series={series} priceFormatter={(value) => `${value.toFixed(2)}%`} />;
}
