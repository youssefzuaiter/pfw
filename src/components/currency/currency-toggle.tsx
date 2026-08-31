"use client";

import { toggleCurrencyDisplayMode, useCurrencyDisplayMode } from "../../lib/hooks/use-currency-display-mode";

/**
 * The Currency UI Toggle's control (Punch List Phase 3, item 2). A named
 * handler (`toggleCurrencyDisplayMode`, imported directly, not wrapped in
 * an inline arrow) on the button element — an inline
 * `onClick={() => toggleCurrencyDisplayMode()}` would trip
 * tests/guards/focus-visible.test.ts's regex-based heuristic, the same
 * trap documented repeatedly across this app's history (AGENTS.md §3c
 * bug #2, hit again as recently as §3ff).
 *
 * One instance of this component anywhere on a screen toggles the SAME
 * app-wide preference every `<CurrencyAmount>` on that screen (and every
 * other screen) reads — see `use-currency-display-mode.ts`'s own doc
 * comment.
 */
export function CurrencyToggle() {
  const mode = useCurrencyDisplayMode();

  return (
    <button
      type="button"
      onClick={toggleCurrencyDisplayMode}
      aria-pressed={mode === "native"}
      className="uv-btn-press rounded-md border border-border px-2 py-1 text-xs font-medium text-fg hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      Showing: {mode === "native" ? "Native currency" : "₪ (ILS)"}
    </button>
  );
}
