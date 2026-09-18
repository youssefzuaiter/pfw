/**
 * A scoped institutional-terminal shell for this standalone route, same
 * mechanism (and reasoning) as `(finance)/layout.tsx`/`/trading/layout.tsx`:
 * a fixed dark canvas is a deliberate visual choice here, not something a
 * user's light/dark theme preference should invert. Does NOT hide the
 * primary `Sidebar`/`MobileNav` (`src/app/layout.tsx`) — confirmed via
 * `src/components/nav/sidebar.tsx`/`mobile-nav.tsx`, both of which only
 * special-case `/trading`, so they render here exactly as they already do
 * on `/dashboard`. A plain `<div>`, not `<main>` — the root layout already
 * renders the page's one `<main>` landmark around this subtree.
 */
export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-full bg-bg text-fg">
      {/* Same single restrained ambient light source as (finance)/layout.tsx
          -- see that file's own doc comment for why this exists and why it's
          kept to one gradient, one color, one low alpha, and why it's a
          Tailwind arbitrary-value class rather than an inline style prop
          (this app's CSP blocks inline styles). */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-[radial-gradient(ellipse_1100px_520px_at_50%_-15%,var(--pfw-accent),transparent_70%)] opacity-[0.07]"
      />
      <div className="relative">{children}</div>
    </div>
  );
}
