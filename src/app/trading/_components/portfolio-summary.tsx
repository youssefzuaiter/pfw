import { formatAgorot, type Agorot } from "../../../lib/money";
import type { PortfolioReturn } from "../../../lib/portfolio-analytics";

function toneClass(value: number): string {
  if (value > 0) return "text-positive";
  if (value < 0) return "text-negative";
  return "text-fg";
}

/** A percentage that may legitimately be undefined (no cost basis) — see PortfolioReturn. */
function formatRate(rate: number | null): string {
  if (rate === null) return "—";
  const sign = rate > 0 ? "+" : "";
  return `${sign}${(rate * 100).toFixed(2)}%`;
}

function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: string;
  hint?: string;
}) {
  return (
    <div className="min-w-[8rem] flex-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className={`font-tabular-figures text-lg font-semibold ${tone ?? "text-fg"}`}>{value}</p>
      {hint && <p className="font-tabular-figures text-xs text-muted">{hint}</p>}
    </div>
  );
}

/**
 * The portfolio's headline figures. `totalGain` deliberately leads over
 * unrealized gain alone: for a dividend-paying portfolio the two differ,
 * and unrealized-only understates actual return — the gap this module
 * exists to close.
 */
export function PortfolioSummary({
  totals,
  trailingDividendIncome,
}: {
  totals: PortfolioReturn;
  trailingDividendIncome: Agorot;
}) {
  return (
    <section className="flex flex-wrap gap-6 rounded-lg border border-border bg-surface p-4">
      <Stat label="Market value" value={formatAgorot(totals.totalMarketValue)} />
      <Stat
        label="Total return"
        value={formatAgorot(totals.totalGain, { showPositiveSign: true })}
        tone={toneClass(totals.totalGain)}
        hint={formatRate(totals.totalReturnRate)}
      />
      <Stat
        label="Unrealized"
        value={formatAgorot(totals.unrealizedGain, { showPositiveSign: true })}
        tone={toneClass(totals.unrealizedGain)}
      />
      <Stat
        label="Realized"
        value={formatAgorot(totals.realizedGain, { showPositiveSign: true })}
        tone={toneClass(totals.realizedGain)}
      />
      <Stat
        label="Dividends"
        value={formatAgorot(totals.dividendIncome, { showPositiveSign: true })}
        tone={toneClass(totals.dividendIncome)}
        hint={`${formatAgorot(trailingDividendIncome)} last 12mo`}
      />
      <Stat label="Cost basis" value={formatAgorot(totals.totalCostBasis)} />
    </section>
  );
}
