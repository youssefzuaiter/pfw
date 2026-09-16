import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import { _resetRateLimitsForTests, checkRateLimit } from "../../src/server/api/rate-limit";
import {
  deleteExpiredRateLimitBuckets,
  incrementRateLimitBucket,
} from "../../src/server/dal/rate-limit-buckets";

/**
 * The Postgres-backed rate-limit store (ad hoc, trader integration
 * hardening — see `rate-limit.ts`'s doc comment for why the in-memory
 * `Map` was a no-op on Vercel). What matters here, and what a unit test
 * against the memory store structurally cannot prove, is that the count
 * lives in the DATABASE: two "instances" — modelled as two independent
 * calls that share nothing but the row — see one another's increments.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("Postgres-backed rate limiting", () => {
  let admin: ReturnType<typeof createAdminClient>;
  const keyPrefix = `it-rate-limit-${Date.now()}`;

  beforeAll(() => {
    admin = createAdminClient();
    delete process.env.RATE_LIMIT_STORE; // force the database store for this suite
  });

  beforeEach(async () => {
    await _resetRateLimitsForTests(keyPrefix);
  });

  afterAll(async () => {
    await admin.rateLimitBucket.deleteMany({ where: { key: { startsWith: keyPrefix } } });
    await admin.$disconnect();
  });

  it("persists the count in the database so a second instance sees the first one's requests", async () => {
    const key = `${keyPrefix}:cross-instance`;
    const options = { windowMs: 60_000, maxRequests: 3 };

    // "Instance A" spends two requests. `checkRateLimit` keeps no
    // per-process state on the DB path, so the only thing carrying the
    // count into the next call is the row itself.
    expect((await checkRateLimit(key, options)).remaining).toBe(2);
    expect((await checkRateLimit(key, options)).remaining).toBe(1);

    const stored = await admin.rateLimitBucket.findFirst({ where: { key } });
    expect(stored?.count).toBe(2);

    // "Instance B" — same key, nothing shared in memory — gets exactly one
    // more, then is blocked. With the old in-memory Map this call would
    // have started from zero.
    expect((await checkRateLimit(key, options)).allowed).toBe(true);
    const blocked = await checkRateLimit(key, options);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.resetAt).toBeGreaterThan(Date.now());
  });

  it("blocks the 31st request of a 30-per-minute window (the guardMutation default)", async () => {
    const key = `${keyPrefix}:thirty`;
    const options = { windowMs: 60_000, maxRequests: 30 };
    for (let i = 0; i < 30; i++) {
      expect((await checkRateLimit(key, options)).allowed).toBe(true);
    }
    expect((await checkRateLimit(key, options)).allowed).toBe(false);
  });

  it("starts a fresh count in a new window and keeps windows apart by primary key", async () => {
    const key = `${keyPrefix}:windows`;
    const windowMs = 60_000;
    const thisWindow = Math.floor(Date.now() / windowMs) * windowMs;
    const previousWindow = thisWindow - windowMs;

    expect(await incrementRateLimitBucket(key, previousWindow, new Date(previousWindow + windowMs))).toBe(1);
    expect(await incrementRateLimitBucket(key, previousWindow, new Date(previousWindow + windowMs))).toBe(2);
    expect(await incrementRateLimitBucket(key, thisWindow, new Date(thisWindow + windowMs))).toBe(1);

    const rows = await admin.rateLimitBucket.findMany({ where: { key }, orderBy: { windowStart: "asc" } });
    expect(rows.map((row) => [Number(row.windowStart), row.count])).toEqual([
      [previousWindow, 2],
      [thisWindow, 1],
    ]);
  });

  it("sweeps only the windows that have expired", async () => {
    const key = `${keyPrefix}:sweep`;
    const windowMs = 60_000;
    const thisWindow = Math.floor(Date.now() / windowMs) * windowMs;
    const staleWindow = thisWindow - 10 * windowMs;

    await incrementRateLimitBucket(key, staleWindow, new Date(staleWindow + windowMs));
    await incrementRateLimitBucket(key, thisWindow, new Date(thisWindow + windowMs));

    const removed = await deleteExpiredRateLimitBuckets();
    expect(removed).toBeGreaterThanOrEqual(1);

    const remaining = await admin.rateLimitBucket.findMany({ where: { key } });
    expect(remaining.map((row) => Number(row.windowStart))).toEqual([thisWindow]);
  });
});
