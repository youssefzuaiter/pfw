"use client";

import { useSyncExternalStore } from "react";

const subscribeNever = () => () => {};

/**
 * `false` on the server and during hydration, `true` afterwards.
 *
 * For content that must not be in the server-rendered HTML at all. The
 * case that needs it here: Recharts server-renders its container with an
 * inline `style` attribute, which this app's CSP blocks (and logs a
 * violation for, every load — AGENTS.md §3x). The same element created on
 * the client is styled through the CSSOM, which the CSP does not govern, so
 * mounting a chart only once this is true avoids the blocked attribute
 * rather than tolerating its console error.
 *
 * `useSyncExternalStore` rather than an effect that sets state, for the
 * reason the 3D hero and the theme toggle give: the client's hydration pass
 * reuses the server's value (no mismatch warning), then re-renders with
 * the real one, and the `react-hooks/set-state-in-effect` rule stays quiet.
 */
export function useIsClient(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
}
