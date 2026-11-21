"use client";

import { useEffect, useRef } from "react";

/**
 * How long a tab can sit open with no mouse, key or touch input before its
 * polling stops. A forgotten tab left open all night was the reason the
 * database never went to sleep (AGENTS.md §3ssss).
 */
export const DEFAULT_IDLE_AFTER_MS = 10 * 60 * 1000;

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "touchstart", "scroll"] as const;

export type UsePollingOptions = {
  /** Time between polls while the tab is visible and in use. */
  intervalMs: number;
  /** Stop after this long with no input. Defaults to `DEFAULT_IDLE_AFTER_MS`. */
  idleAfterMs?: number;
  /**
   * Poll straight away whenever this value changes, and once on mount. Use it for
   * "refresh now" moments such as a route change; the timer alone would wait a
   * whole interval.
   */
  triggerKey?: unknown;
  /** Called when polling pauses (tab hidden or idle) and when it resumes. */
  onPausedChange?: (paused: boolean) => void;
};

/**
 * Calls `poll` on a timer, but only while the page is worth refreshing.
 *
 * Why not a bare `setInterval`: every poll is a request that reaches the
 * database (the login check and the rate limiter both read it), and a Neon
 * database only sleeps after about five minutes with no requests, so a single
 * tab polling every 30 seconds kept it awake around the clock and used up the
 * free compute allowance. Compute is billed by time awake, not by number of
 * queries, so the fix is to stop asking, not to ask cheaper.
 *
 * - A hidden tab makes no requests, and refreshes once when it becomes visible.
 * - A visible tab with no input for `idleAfterMs` stops, and refreshes once when
 *   the person next touches it.
 * - The timer keeps ticking while paused (it costs nothing); each tick just skips.
 *
 * `poll` may change identity every render; the latest one is always used.
 */
export function usePolling(poll: () => void | Promise<void>, options: UsePollingOptions): void {
  const { intervalMs, idleAfterMs = DEFAULT_IDLE_AFTER_MS, triggerKey, onPausedChange } = options;

  const pollRef = useRef(poll);
  const pausedChangeRef = useRef(onPausedChange);
  useEffect(() => {
    pollRef.current = poll;
    pausedChangeRef.current = onPausedChange;
  });

  useEffect(() => {
    let lastActivity = Date.now();
    let paused = document.hidden;

    function setPaused(next: boolean) {
      if (paused === next) return;
      paused = next;
      pausedChangeRef.current?.(next);
    }

    function run() {
      void pollRef.current();
    }

    function onActivity() {
      lastActivity = Date.now();
      if (paused && !document.hidden) {
        setPaused(false);
        run();
      }
    }

    function onVisibility() {
      if (document.hidden) {
        setPaused(true);
        return;
      }
      onActivity();
    }

    function tick() {
      if (document.hidden || Date.now() - lastActivity >= idleAfterMs) {
        setPaused(true);
        return;
      }
      run();
    }

    const interval = setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", onVisibility);
    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, onActivity, { passive: true });

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, onActivity);
    };
  }, [intervalMs, idleAfterMs]);

  useEffect(() => {
    if (!document.hidden) void pollRef.current();
  }, [triggerKey]);
}
