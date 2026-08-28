import type { ReactNode } from "react";

export type BadgeVariant = "positive" | "warning" | "critical" | "neutral";

const VARIANT_CLASS: Record<BadgeVariant, string> = {
  positive: "bg-positive/10 text-positive",
  warning: "bg-signature/10 text-signature",
  critical: "bg-negative/10 text-negative",
  neutral: "bg-border text-muted",
};

/**
 * A small status pill reused across screens (valuation freshness,
 * negative-amortization flags, trade side, goal pace). `pulse` adds the
 * `uv-badge-pulse` breathing animation (globals.css) — only ever set on a
 * status indicator, never on a badge presenting a live financial figure
 * itself (Section 5: "no live financial numbers are animated").
 */
export function Badge({
  variant,
  children,
  pulse = false,
}: {
  variant: BadgeVariant;
  children: ReactNode;
  pulse?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${VARIANT_CLASS[variant]} ${pulse ? "uv-badge-pulse" : ""}`}
    >
      {children}
    </span>
  );
}
