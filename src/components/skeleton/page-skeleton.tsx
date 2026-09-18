/**
 * The shared loading skeleton every route's `loading.tsx` renders.
 *
 * Why this exists at all: every screen in this app is fully dynamic
 * (`export const instant = false` app-wide, so the CSP nonce actually
 * lands on every script tag — see AGENTS.md §3), which means a
 * navigation renders NOTHING until the server has finished every query
 * that page needs. Without a `loading.tsx`, Next keeps the *previous*
 * page on screen for that entire window, so a click reads as "nothing
 * happened" rather than "loading" — the gap is small on localhost and
 * very much not small against a remote database several thousand km
 * away. A `loading.tsx` is what lets React paint an instant response to
 * the click while the server work continues behind it.
 *
 * Deliberately no text ("Loading…", a percentage, a count): a skeleton
 * that mimics the shape of what's coming reads as the page arriving,
 * while a spinner with a label reads as a wait. The blocks carry no
 * text, so the opacity-based `animate-pulse` here doesn't hit the
 * text-contrast problem `uv-badge-pulse` documents in globals.css — and
 * the global `prefers-reduced-motion` guard halts it automatically.
 */
export function PageSkeleton({
  maxWidthClass = "max-w-6xl",
  cardCount = 3,
}: {
  /** Match the real page's own container width so the skeleton doesn't shift layout when the content swaps in. */
  maxWidthClass?: string;
  cardCount?: number;
}) {
  return (
    <div
      className={`mx-auto flex w-full ${maxWidthClass} flex-col gap-4 px-4 py-4 md:px-6`}
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading</span>

      <div className="h-7 w-40 animate-pulse rounded-md bg-elevated" />

      <div className="flex flex-col gap-4">
        {Array.from({ length: cardCount }).map((_, index) => (
          <div
            key={index}
            className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
          >
            <div className="h-4 w-1/3 animate-pulse rounded bg-elevated" />
            <div className="h-8 w-1/2 animate-pulse rounded bg-elevated" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-elevated" />
          </div>
        ))}
      </div>
    </div>
  );
}
