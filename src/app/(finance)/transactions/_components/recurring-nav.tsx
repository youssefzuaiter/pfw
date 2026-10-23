import Link from "next/link";

export type RecurringView = "subscriptions" | "bills";

const TABS: { view: RecurringView; href: string; label: string }[] = [
  { view: "subscriptions", href: "/transactions/subscriptions", label: "Subscriptions" },
  { view: "bills", href: "/transactions/bills", label: "Bills" },
];

/**
 * The tab switcher shared by the two recurring-charge pages. Subscriptions are
 * what the radar found in the statements; bills are what the user typed in
 * (AGENTS.md §3dddd). Same markup as the trading pages' switcher.
 */
export function RecurringNav({ active }: { active: RecurringView }) {
  return (
    <nav className="flex flex-wrap gap-2" aria-label="Recurring charges">
      {TABS.map((tab) =>
        tab.view === active ? (
          <span
            key={tab.view}
            aria-current="page"
            className="rounded-full border border-accent bg-accent/10 px-3 py-1 text-xs font-medium text-accent"
          >
            {tab.label}
          </span>
        ) : (
          <Link
            key={tab.view}
            href={tab.href}
            className="rounded-full border border-border px-3 py-1 text-xs font-medium text-muted hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {tab.label}
          </Link>
        ),
      )}
    </nav>
  );
}
