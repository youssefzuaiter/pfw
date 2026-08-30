import { Badge, type BadgeVariant } from "../../../components/badge/badge";
import { Tickbar, type TickbarStatus } from "../../../components/tickbar/tickbar";
import { formatAgorot, type Agorot } from "../../../lib/money";

/** Emergency-fund convention this card's health tiers are built around: under a month is critical, under a quarter is a warning, 3+ months (≈90 days) reads as healthy — the same 3-6-month range most personal-finance guidance treats as an adequate cash buffer. */
const CRITICAL_THRESHOLD_DAYS = 30;
const WARNING_THRESHOLD_DAYS = 90;
/** What counts as "full" on the Tickbar — 6 months, twice the warning threshold, so the healthy zone isn't a single hairline at the very end of the bar. */
const TARGET_RUNWAY_DAYS = 180;

export type LiquidityRunwayCardProps = {
  availableAgorot: Agorot;
  liquidAgorot: Agorot;
  semiLiquidAgorot: Agorot;
  monthlyBurnRateAgorot: Agorot;
  runwayDays: number | null;
  burnRateSource: "historical_average" | "recurring_commitments_floor" | "none";
};

function runwayHealth(runwayDays: number | null): { status: TickbarStatus; badge: BadgeVariant } {
  if (runwayDays === null) return { status: "good", badge: "positive" };
  if (runwayDays < CRITICAL_THRESHOLD_DAYS) return { status: "critical", badge: "critical" };
  if (runwayDays < WARNING_THRESHOLD_DAYS) return { status: "warning", badge: "warning" };
  return { status: "good", badge: "positive" };
}

function formatRunwayDays(runwayDays: number | null): string {
  if (runwayDays === null) return "No active burn";
  const rounded = Math.round(runwayDays * 10) / 10;
  return `${rounded.toLocaleString("en-US", { maximumFractionDigits: 1 })} days`;
}

const BURN_SOURCE_LABEL: Record<LiquidityRunwayCardProps["burnRateSource"], string> = {
  historical_average: "your trailing 3-month average spend",
  recurring_commitments_floor: "your known recurring bills (thin spending history)",
  none: "no spending history or recurring bills yet",
};

/**
 * The Real-Time Liquidity Runway & Burn-Rate Engine's dashboard
 * indicator (AGENTS.md §3v) — "how many days could you cover essential
 * spending using only cash and market-sellable assets, at your current
 * burn rate." Deliberately not animated (`isAnimationActive`-style
 * concerns don't apply here since this is a static Tickbar, not a
 * Recharts element, but the same "no live financial numbers are
 * animated" spirit, Section 5, is why the Tickbar itself has no
 * transition on its fill).
 */
export function LiquidityRunwayCard({
  availableAgorot,
  liquidAgorot,
  semiLiquidAgorot,
  monthlyBurnRateAgorot,
  runwayDays,
  burnRateSource,
}: LiquidityRunwayCardProps) {
  const health = runwayHealth(runwayDays);
  const percent = runwayDays === null ? 100 : Math.min(100, (runwayDays / TARGET_RUNWAY_DAYS) * 100);

  return (
    <section className="rounded-lg border border-border bg-surface p-4" aria-labelledby="liquidity-runway-heading">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 id="liquidity-runway-heading" className="text-sm font-medium uppercase tracking-wide text-muted">
          Liquidity Runway
        </h2>
        <Badge variant={health.badge} pulse={health.badge === "critical"}>
          {formatRunwayDays(runwayDays)}
        </Badge>
      </div>

      <Tickbar
        label={`Runway toward a ${TARGET_RUNWAY_DAYS}-day (6-month) buffer`}
        percent={percent}
        status={health.status}
      />

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <div>
          <dt className="text-xs text-muted">Available (liquid + semi-liquid)</dt>
          <dd className="font-tabular-figures font-medium text-fg">{formatAgorot(availableAgorot)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Monthly burn rate</dt>
          <dd className="font-tabular-figures font-medium text-fg">{formatAgorot(monthlyBurnRateAgorot)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">— of which liquid (cash)</dt>
          <dd className="font-tabular-figures text-muted">{formatAgorot(liquidAgorot)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">— of which semi-liquid (equities)</dt>
          <dd className="font-tabular-figures text-muted">{formatAgorot(semiLiquidAgorot)}</dd>
        </div>
      </dl>

      <p className="mt-3 text-xs text-muted">
        Based on {BURN_SOURCE_LABEL[burnRateSource]}. Illiquid assets (property, vehicles, locked retirement
        accounts) are excluded — they can&apos;t fund next month&apos;s bills.
      </p>
    </section>
  );
}
