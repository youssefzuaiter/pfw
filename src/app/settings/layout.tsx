/**
 * `/settings`'s own fixed institutional-terminal shell — a fixed dark
 * canvas (Linear/Vercel-inspired: sharp-bordered `neutral-950/60` panels,
 * monospace figures, `neutral-400`/`neutral-100` text), same mechanism
 * (and reasoning) as `(finance)/layout.tsx`'s and `/trading/layout.tsx`'s
 * own fixed dark shells: a deliberate, fixed visual choice for this
 * screen, not something a user's light/dark theme preference should be
 * able to invert. Covers `/settings/open-banking` too — a nested layout
 * applies to every subroute automatically, so no separate layout file is
 * needed there.
 *
 * Unlike `/trading`, this does NOT hide the primary `Sidebar`/`MobileNav`
 * (`src/app/layout.tsx`) — only this screen's own content canvas changes;
 * site navigation is untouched. A plain `<div>`, not `<main>` — the root
 * layout already renders the page's one `<main>` landmark around this
 * subtree; a nested `<main>` here would reproduce the exact real,
 * verified axe `page-no-duplicate-main`/`landmark-unique` violation
 * `/trading/layout.tsx`'s own comment already documents hitting once.
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-full bg-slate-950 text-slate-100">
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
