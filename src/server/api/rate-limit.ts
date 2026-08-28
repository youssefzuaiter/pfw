import "server-only";

/**
 * Sliding-window rate limiter (Section 2.6's DoS backstop). A *sliding*
 * window, not a fixed one: it filters each key's actual request
 * timestamps to the trailing `windowMs`, so a burst can't exploit a
 * fixed-window reset boundary the way naive "N requests per calendar
 * minute" counters can.
 *
 * In-memory, single-process only — correct for this app's current single
 * -instance deployment. A multi-instance Tier 3 deployment would need a
 * shared store (Redis, etc.) instead of this Map; that's a swap-in behind
 * the same `checkRateLimit` signature, not a redesign.
 */

type Bucket = { timestamps: number[] };

const buckets = new Map<string, Bucket>();

export type RateLimitOptions = {
  windowMs: number;
  maxRequests: number;
};

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  /** Epoch ms when the oldest request in the current window will fall out of it. */
  resetAt: number;
};

export function checkRateLimit(key: string, options: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(key) ?? { timestamps: [] };

  bucket.timestamps = bucket.timestamps.filter((t) => now - t < options.windowMs);

  const allowed = bucket.timestamps.length < options.maxRequests;
  if (allowed) {
    bucket.timestamps.push(now);
  }
  buckets.set(key, bucket);

  const remaining = Math.max(0, options.maxRequests - bucket.timestamps.length);
  const resetAt = bucket.timestamps.length > 0 ? bucket.timestamps[0] + options.windowMs : now + options.windowMs;

  return { allowed, remaining, resetAt };
}

/** Test-only: clears all buckets so tests don't leak rate-limit state into each other. */
export function _resetRateLimitsForTests(): void {
  buckets.clear();
}
