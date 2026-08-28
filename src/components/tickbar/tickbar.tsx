/**
 * The app's signature progress meter (Phase 0's design system, "the
 * application's unique signature UI element"): a ruler/price-ladder-style
 * row of ticks rather than a generic rounded bar, reused for budget
 * utilization, goal progress, and debt payoff across every screen that
 * needs one. Static for now (Phase 5 adds the subtle fill-in
 * micro-interaction); severity is never color-only — the percentage is
 * always printed as text too.
 */

export type TickbarStatus = "good" | "warning" | "critical";

const STATUS_FILL_CLASS: Record<TickbarStatus, string> = {
  good: "bg-positive",
  warning: "bg-signature",
  critical: "bg-negative",
};

const TICK_COUNT = 20;

export function Tickbar({ label, percent, status }: { label: string; percent: number; status: TickbarStatus }) {
  const clamped = Math.min(Math.max(percent, 0), 100);
  const filledTicks = Math.round((clamped / 100) * TICK_COUNT);

  return (
    <div>
      <div className="flex items-baseline justify-between text-xs text-muted">
        <span>{label}</span>
        <span className="font-tabular-figures">{Math.round(percent)}%</span>
      </div>
      <div
        className="mt-1 flex h-2 gap-0.5"
        role="progressbar"
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        {Array.from({ length: TICK_COUNT }, (_, index) => (
          <span
            key={index}
            className={`h-full flex-1 rounded-sm ${index < filledTicks ? STATUS_FILL_CLASS[status] : "bg-border"}`}
          />
        ))}
      </div>
    </div>
  );
}
