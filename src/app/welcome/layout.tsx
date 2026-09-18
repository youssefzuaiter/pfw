/**
 * Same scoped institutional-terminal shell as `login/layout.tsx` — see
 * that file's doc comment for the full reasoning. Safe alongside the R3F
 * hero (`src/components/hero/`): `HeroCanvas`'s own container is
 * transparent (`h-full w-full`, no background) and `HeroFallback` paints
 * its own bounded `bg-surface` box, so this page-level dark canvas sits
 * behind both without needing any change to either (neither file was
 * touched by this pass).
 */
export default function WelcomeLayout({ children }: { children: React.ReactNode }) {
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
