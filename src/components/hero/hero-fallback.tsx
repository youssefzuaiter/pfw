/**
 * Static entry-surface fallback: no canvas, no JS animation, just a
 * tokenized CSS gradient. Used whenever the R3F scene shouldn't run —
 * before hydration, under `prefers-reduced-motion: reduce`, or when the
 * browser has no WebGL support — so the hero never leaves an empty box.
 */
export function HeroFallback() {
  return (
    <div
      aria-hidden="true"
      className="h-full w-full rounded-2xl border border-border bg-[radial-gradient(circle_at_25%_20%,var(--pfw-accent)_0%,transparent_55%),radial-gradient(circle_at_80%_75%,var(--pfw-signature)_0%,transparent_50%),radial-gradient(circle_at_50%_100%,var(--pfw-positive)_0%,transparent_45%)] bg-surface opacity-80"
    />
  );
}
