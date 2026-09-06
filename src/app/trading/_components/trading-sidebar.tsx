"use client";

import { Activity, ArrowLeft, LineChart, PieChart, Receipt, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

type SidebarLink = {
  href: string;
  label: string;
  icon: LucideIcon;
};

const TRADING_LINKS: SidebarLink[] = [
  { href: "/trading", label: "Trading desk", icon: LineChart },
  { href: "/trading/portfolio", label: "Portfolio", icon: PieChart },
  { href: "/trading/tax", label: "Tax & Capital Gains", icon: Receipt },
  { href: "/trading/agent", label: "Agent Activity", icon: Activity },
];

function isTradingLinkActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === "/trading") return pathname === "/trading";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The thin, icon-only sidebar `trading/layout.tsx` renders in place of
 * the standard app `Sidebar` (which hides itself for every `/trading`
 * path — see `src/components/nav/sidebar.tsx`). Icon-only by design,
 * unlike the finance shell's expandable/collapsible sidebar — this is
 * meant to stay a thin, permanent strip for a dense, technical desk.
 */
export function TradingSidebar() {
  const pathname = usePathname();

  return (
    <aside className="sticky top-0 flex h-screen w-14 shrink-0 flex-col items-center gap-1 border-r border-neutral-800 bg-neutral-950 py-4">
      <Link
        href="/dashboard"
        title="Back to Dashboard"
        aria-label="Back to Dashboard"
        className="mb-3 flex h-9 w-9 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-800 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        <ArrowLeft className="h-5 w-5" aria-hidden="true" />
      </Link>

      <div className="mb-2 h-px w-8 bg-neutral-800" />

      {TRADING_LINKS.map((link) => {
        const Icon = link.icon;
        const active = isTradingLinkActive(pathname, link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            title={link.label}
            aria-label={link.label}
            aria-current={active ? "page" : undefined}
            className={`flex h-9 w-9 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
              active ? "bg-neutral-800 text-sky-400" : "text-neutral-500 hover:bg-neutral-800 hover:text-neutral-100"
            }`}
          >
            <Icon className="h-5 w-5" aria-hidden="true" />
          </Link>
        );
      })}
    </aside>
  );
}
