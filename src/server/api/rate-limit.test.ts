import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { _resetRateLimitsForTests, checkRateLimit } from "./rate-limit";

/**
 * Exercises the limiter's fixed-window semantics against its in-memory
 * store (`RATE_LIMIT_STORE=memory`) — a unit test must never depend on
 * a database, even when the shell running it has `APP_DATABASE_URL`
 * exported. The Postgres-backed store shares `toResult()`/the window
 * arithmetic with this path and is covered, including the cross-
 * instance persistence that is the whole reason it exists, by
 * `tests/integration/rate-limit-buckets.test.ts`.
 */
describe("checkRateLimit()", () => {
  beforeAll(() => {
    process.env.RATE_LIMIT_STORE = "memory";
  });

  afterEach(async () => {
    await _resetRateLimitsForTests("");
  });

  it("allows requests up to the limit", async () => {
    const key = "user-a";
    for (let i = 0; i < 3; i++) {
      expect((await checkRateLimit(key, { windowMs: 60_000, maxRequests: 3 })).allowed).toBe(true);
    }
  });

  it("blocks the request once the limit is exceeded", async () => {
    const key = "user-b";
    for (let i = 0; i < 3; i++) {
      await checkRateLimit(key, { windowMs: 60_000, maxRequests: 3 });
    }
    expect((await checkRateLimit(key, { windowMs: 60_000, maxRequests: 3 })).allowed).toBe(false);
  });

  it("tracks remaining requests correctly", async () => {
    const key = "user-c";
    expect((await checkRateLimit(key, { windowMs: 60_000, maxRequests: 3 })).remaining).toBe(2);
    expect((await checkRateLimit(key, { windowMs: 60_000, maxRequests: 3 })).remaining).toBe(1);
    expect((await checkRateLimit(key, { windowMs: 60_000, maxRequests: 3 })).remaining).toBe(0);
  });

  it("scopes limits independently per key", async () => {
    const options = { windowMs: 60_000, maxRequests: 1 };
    expect((await checkRateLimit("key-1", options)).allowed).toBe(true);
    expect((await checkRateLimit("key-2", options)).allowed).toBe(true);
    expect((await checkRateLimit("key-1", options)).allowed).toBe(false);
  });

  it("reports resetAt as the end of the current fixed window", async () => {
    const options = { windowMs: 60_000, maxRequests: 1 };
    const before = Date.now();
    const result = await checkRateLimit("key-reset", options);
    const expectedWindowStart = Math.floor(before / options.windowMs) * options.windowMs;
    expect(result.resetAt).toBe(expectedWindowStart + options.windowMs);
    expect(result.resetAt).toBeGreaterThan(before);
  });

  it("allows requests again once the window has fully elapsed", async () => {
    const key = "user-d";
    const options = { windowMs: 20, maxRequests: 1 };
    // Align to the start of a fresh 20ms window so the two calls below
    // can't straddle a boundary by accident.
    await new Promise((resolve) => setTimeout(resolve, 20 - (Date.now() % 20) + 1));
    expect((await checkRateLimit(key, options)).allowed).toBe(true);
    expect((await checkRateLimit(key, options)).allowed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await checkRateLimit(key, options)).allowed).toBe(true);
  });
});
