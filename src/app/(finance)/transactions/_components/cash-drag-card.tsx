/**
 * The monthly and yearly cost of what ONE page lists (AGENTS.md §3eeee): the
 * Subscriptions page totals its own subscriptions, the Bills page its own
 * bills. The two pages are independent, so neither shows the other's money.
 */
export function CashDragCard({ title, monthly, annual, caption }: { title: string; monthly: string; annual: string; caption: string }) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">{title}</h2>
      <p className="font-tabular-figures text-2xl font-semibold tracking-tight text-fg">
        {monthly}
        <span className="text-sm font-normal text-muted"> / month</span>
      </p>
      <p className="font-tabular-figures text-sm tracking-tight text-muted">{annual} / year</p>
      <p className="mt-1 text-xs text-muted">{caption}</p>
    </section>
  );
}
