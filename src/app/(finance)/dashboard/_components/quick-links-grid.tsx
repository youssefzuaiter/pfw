import Link from "next/link";
import { ArrowLeftRight, LineChart, PiggyBank, Radar, Receipt, TrendingUp, type LucideIcon } from "lucide-react";

type QuickLink = {
  href: string;
  label: string;
  icon: LucideIcon;
};

/**
 * Dashboard quick-links to sub-views that are otherwise reachable only
 * by direct link — never added to the sidebar's own `PRIMARY_NAV_ITEMS`
 * (AGENTS.md's repeated "sub-view, not one of the primary destinations"
 * precedent for `/trading/portfolio`, `/trading/tax`, `/analytics`, and
 * `/transactions/subscriptions`). Ordering is deliberate, not
 * alphabetical, per the exact sequence requested: everyday ledger
 * destinations first (Budget, Transactions), the two "worth checking
 * periodically" screens next (Subscription Radar, the trading desk's
 * own portfolio view), ending on the two more analytical, occasional-use
 * screens (Retirement Analytics, Tax Simulation).
 *
 * Icons deliberately REUSE the sidebar's own choice for any destination
 * that already has one there (`nav-items.ts`'s `PiggyBank`/
 * `ArrowLeftRight`/`LineChart`) — one visual vocabulary for "this icon
 * means this destination" across the app, not a second, different icon
 * for the same screen depending on where you see it.
 */
const QUICK_LINKS: QuickLink[] = [
  { href: "/budgets", label: "Budget", icon: PiggyBank },
  { href: "/transactions", label: "Transactions", icon: ArrowLeftRight },
  { href: "/transactions/subscriptions", label: "Subscription Radar", icon: Radar },
  { href: "/trading/portfolio", label: "Trading / Portfolio", icon: LineChart },
  { href: "/analytics", label: "Retirement Analytics", icon: TrendingUp },
  { href: "/trading/tax", label: "Tax Simulation", icon: Receipt },
];

/**
 * Condensed into a single-row, low-height toolbar (institutional-terminal
 * pass) — the original vertical icon-over-label grid of large `p-4` cards
 * took up a full screenful of vertical space above the fold for what is,
 * functionally, a row of six links; this gives that real estate back to
 * the Net Worth chart and Attention Feed immediately below. Same links,
 * same order, same icons, same destinations — only the container/item
 * markup changed.
 */
export function QuickLinksGrid() {
  return (
    <nav aria-label="Quick links" className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
      {QUICK_LINKS.map((link) => {
        const Icon = link.icon;
        return (
          <Link
            key={link.href}
            href={link.href}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:border-muted/40 hover:bg-elevated hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Icon className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
