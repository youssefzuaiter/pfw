"use client";

import { useSyncExternalStore } from "react";
import { WifiOff } from "lucide-react";

/**
 * A slim, app-wide "you're offline" indicator (ad hoc — GITEX-style
 * demo resilience) — distinct from `public/sw.js`'s offline FALLBACK
 * PAGE, which only ever catches a full-page navigation that fails with
 * no network. This banner covers the gap that leaves open: a dropped
 * connection while already on a live screen (e.g. mid-dashboard, an
 * in-app client-side navigation, a background poll) never triggers a
 * full-page navigation at all, so the service worker's `fetch` handler
 * never sees it. This is a pure CONNECTIVITY signal — it never claims
 * anything about whether on-screen data is fresh, so it carries none of
 * the "stale financial figure" risk this app's standing data-freshness
 * rule (`sw.js`'s own doc comment) exists to prevent; it only ever
 * states the one fact that's always true regardless of what's rendered:
 * this device currently has no network.
 *
 * `useSyncExternalStore`, not `useEffect` + `setState` — same reasoning
 * as `useCurrencyDisplayMode`/the offline page itself: a browser-only
 * source of truth with no synchronous-setState-in-an-effect trap to
 * avoid.
 *
 * `navigator.onLine` reports whether the OS thinks a network interface
 * is up, not genuine internet reachability (a captive portal or a
 * doesn't-actually-route Wi-Fi AP can still read `true`) — an honest,
 * known limitation of the browser API this component is built on, not
 * something worth a second live-reachability check for a lightweight
 * banner like this one.
 */
function subscribeToOnlineStatus(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

function getOnlineSnapshot() {
  return navigator.onLine;
}

// Assume online on the server (there is no real connectivity state to
// read there) — corrected on the client the instant hydration reads the
// real snapshot, the same "fail toward the common case" reasoning this
// app's other `useSyncExternalStore` server snapshots already use.
function getServerOnlineSnapshot() {
  return true;
}

export function OfflineBanner() {
  const isOnline = useSyncExternalStore(subscribeToOnlineStatus, getOnlineSnapshot, getServerOnlineSnapshot);

  if (isOnline) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-2 bg-negative px-4 py-2 text-center text-sm font-medium text-bg"
    >
      <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
      You&rsquo;re offline &mdash; live data will resume automatically once reconnected.
    </div>
  );
}
