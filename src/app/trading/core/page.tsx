import { CurrencyToggle } from "../../../components/currency/currency-toggle";
import { getCurrentUser } from "../../../server/auth/current-user";
import { buildCoreAgentData } from "../../../server/core/build-core-agent-data";
import { CoreAccountCard } from "../_components/core-account-card";
import { CoreAllocationTable } from "../_components/core-allocation-table";
import { CoreEmptyState, CoreUnavailable } from "../_components/core-empty-state";
import { CoreJournalFeed } from "../_components/core-journal-feed";
import { CoreOpenPlanCard } from "../_components/core-plan-card";
import { CorePlanHistory } from "../_components/core-plan-history";
import { CoreStatusCard } from "../_components/core-status-card";
import { TradingNav } from "../_components/trading-nav";

export const instant = false;

/**
 * The long-term core (AGENTS.md §3fff): a READ-ONLY view of a separate
 * service — `~/paper-trader`'s core router, which trades its own Alpaca
 * paper account on a quarterly rule and keeps an append-only, hash-chained
 * journal of everything it does. The router pushes that journal and its
 * own status here; this page shows them, and verifies the journal's hash
 * chain from the stored lines on every load.
 *
 * Nothing on this page can change anything. Approving a plan, raising
 * cash and the kill switch are signed commands to the router
 * (`core_ctl`), and this app holds no credential for it, on purpose: a
 * page that could approve trades would turn a stolen login into a
 * trading account. And nothing here is part of net worth or any other
 * aggregate — the core is a separate paper account, mirrored for viewing.
 *
 * Shows the paper-trading account's data only (whichever account
 * `PAPER_TRADING_USER_EMAIL` names); anyone else sees the empty state.
 */
export default async function CoreAgentPage() {
  const user = await getCurrentUser();
  const data = await buildCoreAgentData(user.id);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-6 md:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-semibold text-fg">Long-term core</h1>
        <TradingNav active="core" />
      </div>

      <p className="text-sm text-muted">
        A read-only view of the long-term core: a separate paper account that holds a fixed mix of ETFs for years and
        rebalances quarterly. Paper money, no real funds, not financial advice.
      </p>

      {data.state === "unavailable" ? (
        <CoreUnavailable />
      ) : data.state === "empty" ? (
        <CoreEmptyState />
      ) : (
        <>
          <CoreStatusCard data={data} />

          {data.account && (
            <>
              <CoreAccountCard account={data.account} />
              <section className="rounded-lg border border-border bg-surface p-4" aria-labelledby="core-allocation-heading">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h2 id="core-allocation-heading" className="text-sm font-medium uppercase tracking-wide text-muted">
                    Holdings against target
                  </h2>
                  <CurrencyToggle />
                </div>
                <CoreAllocationTable account={data.account} />
              </section>
            </>
          )}

          <CoreOpenPlanCard plan={data.openPlan} />

          <section className="rounded-lg border border-border bg-surface p-4" aria-labelledby="core-history-heading">
            <h2 id="core-history-heading" className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">
              Plan history
            </h2>
            <CorePlanHistory plans={data.plans} openPlan={data.openPlan} />
          </section>

          <section className="rounded-lg border border-border bg-surface p-4" aria-labelledby="core-journal-heading">
            <h2 id="core-journal-heading" className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">
              Journal
            </h2>
            <CoreJournalFeed events={data.events} hiddenCount={data.hiddenEventCount} />
          </section>
        </>
      )}

      <p className="text-xs text-muted">
        Everything above is a copy of what the router wrote, held read-only. The record itself is the router&rsquo;s own
        append-only journal; each line here carries the hash of the line before it, and this page re-checks that chain
        every time it loads. A broken chain means this copy was altered or damaged, not that the router did anything.
      </p>
    </div>
  );
}
