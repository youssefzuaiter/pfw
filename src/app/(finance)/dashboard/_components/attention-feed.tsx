import type { Insight, InsightSeverity } from "../../../../lib/insights/generate-insights";

const SEVERITY_STYLES: Record<InsightSeverity, { dot: string; label: string }> = {
  critical: { dot: "bg-negative", label: "Critical" },
  warning: { dot: "bg-signature", label: "Warning" },
  info: { dot: "bg-accent", label: "Info" },
};

/**
 * The ranked attention feed — `insights` arrives already sorted by
 * `generateInsights()` (severity first, impact breaks ties). Severity is
 * never conveyed by color alone: a screen-reader-only label precedes
 * each title, so the feed reads correctly without relying on the dot's
 * color (Phase 0 self-critique: color-only severity fails colorblind
 * users).
 *
 * `className` is how the dashboard grid (`src/app/(finance)/dashboard/page.tsx`)
 * makes this card span both rows next to the stacked Net Worth +
 * Liquidity Runway cards. `h-full flex flex-col` on the section itself —
 * not just the grid wrapper — is what actually makes the card's visible
 * border/background stretch to match that combined height exactly,
 * rather than leaving empty space below a content-sized card inside a
 * taller grid cell; the list scrolls internally (`min-h-0 overflow-y-auto`
 * on a flex child, the standard fix for a flex item ignoring its
 * parent's height when its content is allowed to grow unbounded) so a
 * long insight list never re-introduces the very gap this was built to
 * close by growing past the two stacked cards instead.
 */
export function AttentionFeed({ insights, className }: { insights: readonly Insight[]; className?: string }) {
  return (
    <section
      className={`flex h-full flex-col rounded-lg border border-slate-800/80 bg-slate-900 p-4 ${className ?? ""}`}
      aria-labelledby="attention-feed-heading"
    >
      <h2
        id="attention-feed-heading"
        className="mb-3 flex-shrink-0 text-xs font-medium uppercase tracking-wide text-slate-400"
      >
        Attention feed
      </h2>
      {insights.length === 0 ? (
        <p className="text-sm text-slate-400">Nothing needs your attention right now.</p>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          {insights.map((insight, index) => {
            const style = SEVERITY_STYLES[insight.severity];
            return (
              <li key={`${insight.type}-${insight.relatedEntityId ?? index}`} className="flex flex-shrink-0 gap-3">
                <span className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${style.dot}`} aria-hidden="true" />
                <div>
                  <p className="text-sm font-medium text-slate-100">
                    <span className="sr-only">{style.label}: </span>
                    {insight.title}
                  </p>
                  <p className="text-sm text-slate-400">{insight.description}</p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
