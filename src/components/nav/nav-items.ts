import {
  ArrowLeftRight,
  CreditCard,
  Landmark,
  LayoutDashboard,
  LineChart,
  PiggyBank,
  ShieldCheck,
  Sparkles,
  Tags,
  Target,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  /** Shown alongside `label` when expanded, and alone (with `label` as a tooltip + sr-only text) when the sidebar is collapsed (`Sidebar`'s own collapse toggle). */
  icon: LucideIcon;
};

/**
 * Ordered by how often a user actually opens each screen, not by data-
 * dependency logic (an earlier version of this list ordered Categories
 * right after Transactions because categories organize transactions —
 * a fine *logical* argument, but not how anyone actually navigates: user
 * feedback flagged that order as wrong, and the real complaint was
 * Categories sitting at position 3 despite being an admin/setup screen
 * nobody opens on a daily basis).
 *
 * Overview first (Dashboard), then the three screens someone genuinely
 * checks often (Transactions -> Budgets -> Goals), then Analytics
 * (retirement planning — grouped with Goals as long-term-planning
 * tools), then the two net-worth components checked periodically rather
 * than daily (Assets -> Debts), then Vault (protects that same net
 * worth — grouped right after it, not buried at the very end), then
 * Categories (setup, rarely visited on its own), then Trading (a
 * separate, self-contained desk), and Advisor last (a tool you reach
 * for, not a destination you land on).
 *
 * Analytics (`/analytics`) and Vault (`/vault`) were promoted here from
 * "sub-view, reachable only via the dashboard's quick-links row / a
 * direct link" (AGENTS.md's long-standing convention for `/trading/
 * portfolio`, `/trading/tax`, `/transactions/subscriptions`, etc.) at
 * explicit user request — both are genuinely major, standalone features
 * (a retirement Monte Carlo simulator; a cryptographic dead man's
 * switch with real beneficiaries and encrypted documents), not thin
 * sub-pages, so promoting them doesn't strain that convention the way
 * promoting every sub-view would. `/trading/portfolio`, `/trading/tax`,
 * and `/trading/agent` were deliberately NOT promoted — they already
 * have their own dedicated sub-nav inside the Trading desk
 * (`TradingSidebar`), so adding them here would be redundant, not
 * additive.
 */
export const PRIMARY_NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/transactions", label: "Transactions", icon: ArrowLeftRight },
  { href: "/budgets", label: "Budgets", icon: PiggyBank },
  { href: "/goals", label: "Goals", icon: Target },
  { href: "/analytics", label: "Analytics", icon: TrendingUp },
  { href: "/assets", label: "Assets", icon: Landmark },
  { href: "/debts", label: "Debts", icon: CreditCard },
  { href: "/vault", label: "Vault", icon: ShieldCheck },
  { href: "/categories", label: "Categories", icon: Tags },
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
