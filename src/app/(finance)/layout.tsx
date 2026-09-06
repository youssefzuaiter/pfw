/**
 * Deliberately a pass-through. "(finance)" exists as a route group so
 * Dashboard/Budget/Transactions/Subscription Radar/Retirement Analytic can
 * be moved under one URL-invisible folder without changing any of their
 * routes — it's the structural counterpart to `/trading`'s own dark,
 * monospace shell (`src/app/trading/layout.tsx`), not a second visual
 * theme of its own. The approachable, light-mode, card-based aesthetic
 * these screens already have comes from the root shell
 * (`src/app/layout.tsx`'s `Sidebar`/`MobileNav` + `globals.css`'s default
 * token values) exactly as before this split — this layout only needs to
 * exist at all so a future finance-only concern has somewhere to live
 * without touching the trading desk.
 */
export default function FinanceLayout({ children }: { children: React.ReactNode }) {
  return children;
}
