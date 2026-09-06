import {
  ArrowLeftRight,
  CreditCard,
  Landmark,
  LayoutDashboard,
  LineChart,
  PiggyBank,
  Sparkles,
  Tags,
  Target,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  /** Shown alongside `label` when expanded, and alone (with `label` as a tooltip + sr-only text) when the sidebar is collapsed (`Sidebar`'s own collapse toggle). */
  icon: LucideIcon;
};

/**
 * Ordered deliberately, not alphabetically or by ship date: an overview
 * first, then the ledger group (Transactions -> Categories -> Budgets,
 * since categories organize transactions and budgets are set per
 * category), then the wealth-tracking group (Goals -> Debts -> Assets),
 * then Trading (a separate desk, not part of the core ledger), and the
 * Advisor last (a tool you reach for, not a destination you land on).
 */
export const PRIMARY_NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/transactions", label: "Transactions", icon: ArrowLeftRight },
  { href: "/categories", label: "Categories", icon: Tags },
  { href: "/budgets", label: "Budgets", icon: PiggyBank },
  { href: "/goals", label: "Goals", icon: Target },
  { href: "/debts", label: "Debts", icon: CreditCard },
  { href: "/assets", label: "Assets", icon: Landmark },
  { href: "/trading", label: "Trading", icon: LineChart },
  { href: "/advisor", label: "Advisor", icon: Sparkles },
];

// Mobile: 4 primary tabs + a "More" drawer for the rest — never crowd 7+
// items into a 375px bar (Phase 0 design decision).
export const MOBILE_PRIMARY_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/transactions", label: "Transactions", icon: ArrowLeftRight },
  { href: "/budgets", label: "Budgets", icon: PiggyBank },
];

export const MOBILE_MORE_ITEMS: NavItem[] = PRIMARY_NAV_ITEMS.filter(
  (item) => !MOBILE_PRIMARY_ITEMS.some((primary) => primary.href === item.href),
);

export function isNavItemActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}
