import "server-only";
import { cache } from "react";
import { agorot, type Agorot } from "../../lib/money";
import { computeLiveNetWorth } from "../dal/net-worth";
import { getDailyNetCashFlow } from "../dal/transactions";

const HISTORY_WINDOW_DAYS = 90;

export type RunwayForecastData = {
  /** Today's liquid balance (AGENTS.md §3v's liquidity classification) — the anchor the client-side rollout projects forward from. Never the full net worth figure, which includes illiquid assets/debts that don't move day-to-day the way a checking-account balance does. */
  startingLiquidAgorot: Agorot;
  /** Dense (zero-filled) daily net cash-flow for the trailing HISTORY_WINDOW_DAYS — exactly what the forecaster Worker's LSTM warmup phase teacher-forces over. */
  dailyHistory: { dateKey: string; netAgorot: number }[];
};

/**
 * Assembles the two inputs `RunwayForecastChart`
 * (src/app/dashboard/_components/runway-forecast-chart.tsx) hands to
 * the forecaster Worker (AGENTS.md §3dd). Deliberately does NOT run any
 * forecast itself, unlike build-monte-carlo-data.ts — the actual
 * inference (ONNX model warmup + Monte Carlo rollout) only ever runs
 * client-side, in the Worker, so this function's whole job is fetching
 * and shaping real data, nothing more.
 *
 * `netAgorot` is returned as a plain `number`, not `bigint` — this data
 * crosses a Server→Client Component prop boundary (React serializes
 * props not unlike a JSON body), and `bigint` can't cross that boundary
 * any more than it can cross `NextResponse.json()` (AGENTS.md §3d's
 * documented bug class, applied here to props instead of a fetch
 * response). A daily cash-flow delta is always safely within
 * `Number.MAX_SAFE_INTEGER` for any realistic account.
 */
export const buildRunwayForecastData = cache(async (userId: string): Promise<RunwayForecastData> => {
  const now = new Date();
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - HISTORY_WINDOW_DAYS);

  const [netWorth, history] = await Promise.all([computeLiveNetWorth(userId, now), getDailyNetCashFlow(userId, from, now)]);

  return {
    startingLiquidAgorot: netWorth.liquidity.liquidAgorot,
    dailyHistory: history.map((day) => ({ dateKey: day.dateKey, netAgorot: agorot(Number(day.netAgorot)) })),
  };
});
