import "server-only";
import { prisma } from "../db/client";

/**
 * Persistence for `src/server/api/rate-limit.ts`'s fixed-window counters
 * (ad hoc, trader integration hardening — see the `RateLimitBucket`
 * model's own doc comment for why a table replaced the process-local
 * `Map`).
 *
 * Deliberately skips `withUserScope`, exactly like `exchange-rates.ts`:
 * `RateLimitBucket` holds no user data and has no RLS policy, so setting
 * `app.current_user_id` here would be ceremony implying a scoping
 * guarantee that doesn't exist. Several keys legitimately have no user
 * at all (`auth:login:<email>` for a caller who isn't signed in yet,
 * `register:global`).
 *
 * The increment is ONE statement, not read-then-write: two lambdas (or
 * two concurrent requests in one process) hitting the same key race
 * only on Postgres's own row lock, so the count can never be lost the
 * way a `get` + `set` would lose it.
 */
export async function incrementRateLimitBucket(
  key: string,
  windowStartMs: number,
  expiresAt: Date,
): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO "RateLimitBucket" ("key", "windowStart", "count", "expiresAt")
    VALUES (${key}, ${BigInt(windowStartMs)}, 1, ${expiresAt})
    ON CONFLICT ("key", "windowStart")
    DO UPDATE SET "count" = "RateLimitBucket"."count" + 1
    RETURNING "count"
  `;
  return rows[0]?.count ?? 1;
}

/** Sweeps windows that have fully elapsed. Called by the daily `/api/cron` job; returns the number of rows removed. */
export async function deleteExpiredRateLimitBuckets(now: Date = new Date()): Promise<number> {
  const result = await prisma.rateLimitBucket.deleteMany({ where: { expiresAt: { lt: now } } });
  return result.count;
}

/** Test-only: removes the buckets one suite owns (by key prefix) without touching another parallel suite's rows. */
export async function _deleteRateLimitBucketsByPrefixForTests(keyPrefix: string): Promise<void> {
  await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: keyPrefix } } });
}
