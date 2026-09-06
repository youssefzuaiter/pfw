import { TradingSidebar } from "./_components/trading-sidebar";

/**
 * The technical-workflow counterpart to the standard finance shell
 * (`src/app/layout.tsx`'s `Sidebar`/`MobileNav`, which both return
 * `null` for any `/trading` path — see their own comments). `/trading`
 * is already its own real URL segment (not a route group), so this is
 * the ordinary Next.js mechanism for giving one subtree of routes a
 * different layout with no change to any of its URLs.
 *
 * Deliberately does NOT use the app's `bg-bg`/`text-fg` design tokens,
 * which flip between this app's own light/dark theme toggle — a "dark
 * background" for a dense, technical desk is a fixed aesthetic choice
 * for this subtree specifically, not something a user's light/dark
 * preference should be able to invert. Tailwind's own neutral scale is
 * used directly for that reason; `font-tabular` (already defined in
 * `globals.css` as IBM Plex Mono + a monospace fallback stack, the same
 * font every monetary table cell in this app already uses) is applied
 * to the whole subtree, not just figures, per the "strict monospace
 * font stack for dense tabular data" ask.
 */
export default function TradingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-neutral-950 font-tabular text-neutral-100">
      <TradingSidebar />
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
