import Link from "next/link";

export type TradingView = "desk" | "portfolio" | "tax";

const TABS: { view: TradingView; href: string; label: string }[] = [
  { view: "desk", href: "/trading", label: "Trading desk" },
  { view: "portfolio", href: "/trading/portfolio", label: "Portfolio" },
  { view: "tax", href: "/trading/tax", label: "Tax & Capital Gains" },
];

/** The tab switcher shared by all three /trading sub-views (desk, portfolio, tax) — extracted once three copies of the same markup would otherwise exist. */
export function TradingNav({ active }: { active: TradingView }) {
  return (
    <nav className="flex flex-wrap gap-2" aria-label="Trading views">
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
