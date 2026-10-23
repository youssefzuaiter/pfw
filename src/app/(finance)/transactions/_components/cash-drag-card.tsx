/**
 * The combined monthly and yearly cost of every active recurring charge: the
 * ones detected from statements and the bills added by hand. One figure,
 * shown on both recurring pages, because splitting it would understate what
 * actually leaves the account (AGENTS.md §3dddd).
 */
export function CashDragCard({ monthly, annual }: { monthly: string; annual: string }) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Recurring cash drag</h2>
      <p className="font-tabular-figures text-2xl font-semibold tracking-tight text-fg">
        {monthly}
        <span className="text-sm font-normal text-muted"> / month</span>
      </p>
      <p className="font-tabular-figures text-sm tracking-tight text-muted">{annual} / year</p>
      <p className="mt-1 text-xs text-muted">
        Counts both the subscriptions found in your statements and the bills you added by hand, so nothing is left out.
      </p>
    </section>
  );
}
