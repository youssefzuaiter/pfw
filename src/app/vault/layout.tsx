/**
 * `/vault`'s own fixed institutional-terminal shell — same mechanism (and
 * reasoning) as `(finance)/layout.tsx`'s and `/trading/layout.tsx`'s
 * fixed dark shells. Covers `/vault/recover/[token]` too — a nested
 * layout applies to every subroute automatically.
 *
 * Verified this doesn't interact with that subroute's auth story before
 * adding it: `src/proxy.ts`'s `PUBLIC_PATH_PREFIXES` allowlists
 * `/vault/recover/` by a plain pathname-prefix check in middleware, which
 * runs entirely before this (or any) React layout renders — a
 * beneficiary reaching that page with no PFW session is unaffected by
 * this file either way; it only changes what the page looks like once
 * middleware has already let the request through.
 *
 * Unlike `/trading`, this does NOT hide the primary `Sidebar`/`MobileNav`
 * (`src/app/layout.tsx`) — only this screen's own content canvas changes.
 * A plain `<div>`, not `<main>` — the root layout already renders the
 * page's one `<main>` landmark around this subtree; a nested `<main>`
 * here would reproduce the exact real, verified axe
 * `page-no-duplicate-main`/`landmark-unique` violation `/trading/layout.tsx`'s
 * own comment already documents hitting once.
 */
export default function VaultLayout({ children }: { children: React.ReactNode }) {
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
