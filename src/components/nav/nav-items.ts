export type NavItem = {
  href: string;
  label: string;
};

export const PRIMARY_NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/transactions", label: "Transactions" },
  { href: "/budgets", label: "Budgets" },
  { href: "/goals", label: "Goals" },
  { href: "/debts", label: "Debts" },
  { href: "/assets", label: "Assets" },
  { href: "/categories", label: "Categories" },
  { href: "/trading", label: "Trading" },
  { href: "/advisor", label: "Advisor" },
];

// Mobile: 4 primary tabs + a "More" drawer for the rest — never crowd 7+
// items into a 375px bar (Phase 0 design decision).
export const MOBILE_PRIMARY_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/transactions", label: "Transactions" },
  { href: "/budgets", label: "Budgets" },
];

export const MOBILE_MORE_ITEMS: NavItem[] = PRIMARY_NAV_ITEMS.filter(
  (item) => !MOBILE_PRIMARY_ITEMS.some((primary) => primary.href === item.href),
);

export function isNavItemActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}
