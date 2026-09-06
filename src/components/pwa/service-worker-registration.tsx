"use client";

import { useEffect } from "react";

/**
 * Registers `public/sw.js` (Phase 4, ad hoc) — production only, matching
 * the task's own "disable the service worker in development" intent: a
 * dev-mode service worker would cache a Turbopack dev bundle that
 * changes on every save, fighting Fast Refresh rather than helping
 * anything. `navigator.serviceWorker` is itself feature-detected — this
 * quietly no-ops on a browser that lacks it, never throws.
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
      console.error("Service worker registration failed", error);
    });
  }, []);

  return null;
}
