import "server-only";
import { isAppDatabaseConfigured } from "../env";
import { incrementRateLimitBucket, _deleteRateLimitBucketsByPrefixForTests } from "../dal/rate-limit-buckets";

/**
 * Fixed-window rate limiter (Section 2.6's DoS backstop), backed by
 * Postgres (`RateLimitBucket`, via `src/server/dal/rate-limit-buckets.ts`).
 *
 * History, because the trade-off changed: this started as a *sliding*
 * window over an in-memory `Map` of timestamps — correct for a single
 * long-lived process, and a no-op on the deployment this app actually
 * runs on. Vercel (AGENTS.md §3pp) is serverless: every lambda instance
 * has its own heap, so a per-process `Map` meant the advisor's 10-request
 * cap, the webhook limits, and the login throttle were all effectively
 * unenforced in production. A shared store fixes that; a *fixed* window
 * is what makes the shared increment a single atomic `INSERT … ON
 * CONFLICT DO UPDATE` instead of a read-filter-write of a timestamp
 * array. The cost is the classic fixed-window edge (up to 2× the limit
 * across one boundary) — accepted, stated here, and irrelevant to every
 * limit in this app, none of which is tuned that tightly.
 *
 * Store selection, per call: the in-memory `Map` is used only when
 * `RATE_LIMIT_STORE=memory` is set (the unit-test projects, which must
 * never depend on a database) or when `APP_DATABASE_URL` isn't
 * configured at all. Otherwise Postgres. A database error mid-check
 * degrades to the memory store for that call (fail-OPEN, logged): a
 * limiter that can't reach its store should not take the whole app down
 * with it — availability wins over strictness here, the same call
 * `getLatestRateTable`'s never-throw contract already makes for FX.
 */

type MemoryBucket = { windowStart: number; count: number };

const memoryBuckets = new Map<string, MemoryBucket>();

/** One warning per key per minute when the DB store is unreachable, so a real outage is visible without flooding the log. */
const lastFallbackWarningAt = new Map<string, number>();
const FALLBACK_WARNING_INTERVAL_MS = 60_000;

export type RateLimitOptions = {
  windowMs: number;
  maxRequests: number;
};

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  /** Epoch ms when the current fixed window ends and the count resets. */
  resetAt: number;
};

function shouldUseMemoryStore(): boolean {
  return process.env.RATE_LIMIT_STORE === "memory" || !isAppDatabaseConfigured();
}

function incrementInMemory(key: string, windowStart: number): number {
  const bucket = memoryBuckets.get(key);
  if (bucket && bucket.windowStart === windowStart) {
    bucket.count += 1;
    return bucket.count;
  }
  memoryBuckets.set(key, { windowStart, count: 1 });
  return 1;
}

function toResult(count: number, windowStart: number, options: RateLimitOptions): RateLimitResult {
  return {
    allowed: count <= options.maxRequests,
    remaining: Math.max(0, options.maxRequests - count),
    resetAt: windowStart + options.windowMs,
  };
}

export async function checkRateLimit(key: string, options: RateLimitOptions): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = Math.floor(now / options.windowMs) * options.windowMs;

  if (shouldUseMemoryStore()) {
    return toResult(incrementInMemory(key, windowStart), windowStart, options);
  }

  try {
    const count = await incrementRateLimitBucket(key, windowStart, new Date(windowStart + options.windowMs));
    return toResult(count, windowStart, options);
  } catch (error) {
    const lastWarned = lastFallbackWarningAt.get(key) ?? 0;
    if (now - lastWarned > FALLBACK_WARNING_INTERVAL_MS) {
      lastFallbackWarningAt.set(key, now);
      console.warn(`rate-limit: Postgres store unavailable for "${key}", falling back to process memory`, error);
    }
    return toResult(incrementInMemory(key, windowStart), windowStart, options);
  }
}

/**
 * Test-only. Clears the process-local memory store outright, and — when
 * the database store is active — deletes only the rows whose key starts
 * with `keyPrefix`. The prefix is REQUIRED, not optional, because Vitest
 * runs integration files in parallel workers against one shared
 * database: an unscoped "delete everything" from one suite's `beforeAll`
 * raced another suite's in-flight increments and made its assertions
 * flake (caught the first time this suite ran, not assumed).
 */
export async function _resetRateLimitsForTests(keyPrefix: string): Promise<void> {
  memoryBuckets.clear();
  lastFallbackWarningAt.clear();
  if (!shouldUseMemoryStore()) {
    await _deleteRateLimitBucketsByPrefixForTests(keyPrefix);
  }
}
