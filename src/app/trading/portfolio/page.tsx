import Link from "next/link";
import { Badge } from "../../../components/badge/badge";
import { getCurrentUser } from "../../../server/auth/current-user";
import { buildPortfolioData } from "../../../server/portfolio/build-portfolio-data";
import { AllocationBar } from "../_components/allocation-bar";
import { DividendSchedule } from "../_components/dividend-schedule";
import { PortfolioSummary } from "../_components/portfolio-summary";
import { PositionsTable } from "../_components/positions-table";

export const instant = false;

export default async function PortfolioPage() {
  const user = await getCurrentUser();
  const data = await buildPortfolioData(user.id);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-6 md:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-semibold text-fg">Portfolio</h1>
        <nav className="flex gap-2" aria-label="Trading views">
          <Link
            href="/trading"
            className="rounded-full border border-border px-3 py-1 text-xs font-medium text-muted hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Trading desk
          </Link>
          <span
            aria-current="page"
            className="rounded-full border border-accent bg-accent/10 px-3 py-1 text-xs font-medium text-accent"
          >
            Portfolio
          </span>
        </nav>
      </div>

      <PortfolioSummary totals={data.totals} trailingDividendIncome={data.trailingDividendIncome} />

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">Allocation</h2>
        {data.allocation.length === 0 ? (
          <p className="text-sm text-muted">No open positions to allocate.</p>
        ) : (
          <AllocationBar allocation={data.allocation} />
        )}
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">Positions</h2>
        {data.rows.length === 0 ? (
          <p className="text-sm text-muted">
            No open positions.{" "}
            <Link
              href="/trading"
              className="text-accent underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Place an order
            </Link>{" "}
            to get started.
          </p>
        ) : (
          <PositionsTable rows={data.rows} />
        )}
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted">Upcoming dividends</h2>
          {data.upcomingPayouts.length > 0 && (
            <Badge variant="neutral">
              {data.upcomingPayouts.length} scheduled
            </Badge>
          )}
        </div>
        {data.upcomingPayouts.length === 0 ? (
          <p className="text-sm text-muted">
            No dividends scheduled. Positions in non-distributing assets (crypto and growth stocks) pay none.
          </p>
        ) : (
          <DividendSchedule payouts={data.upcomingPayouts} />
        )}
      </section>

      <p className="text-xs text-muted">
        Prices come from the simulated market feed. Positions are held in their native currency and converted
        to shekels at the latest synced exchange rate; both figures are shown side by side.
      </p>
    </div>
  );
}
