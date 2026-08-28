import { afterEach, describe, expect, it } from "vitest";
import { _resetRateLimitsForTests, checkRateLimit } from "./rate-limit";

describe("checkRateLimit()", () => {
  afterEach(() => {
    _resetRateLimitsForTests();
  });

  it("allows requests up to the limit", () => {
    const key = "user-a";
    for (let i = 0; i < 3; i++) {
      expect(checkRateLimit(key, { windowMs: 60_000, maxRequests: 3 }).allowed).toBe(true);
    }
  });

  it("blocks the request once the limit is exceeded", () => {
    const key = "user-b";
    for (let i = 0; i < 3; i++) {
      checkRateLimit(key, { windowMs: 60_000, maxRequests: 3 });
    }
    expect(checkRateLimit(key, { windowMs: 60_000, maxRequests: 3 }).allowed).toBe(false);
  });

  it("tracks remaining requests correctly", () => {
    const key = "user-c";
    expect(checkRateLimit(key, { windowMs: 60_000, maxRequests: 3 }).remaining).toBe(2);
    expect(checkRateLimit(key, { windowMs: 60_000, maxRequests: 3 }).remaining).toBe(1);
    expect(checkRateLimit(key, { windowMs: 60_000, maxRequests: 3 }).remaining).toBe(0);
  });

  it("scopes limits independently per key", () => {
    const options = { windowMs: 60_000, maxRequests: 1 };
    expect(checkRateLimit("key-1", options).allowed).toBe(true);
    expect(checkRateLimit("key-2", options).allowed).toBe(true);
    expect(checkRateLimit("key-1", options).allowed).toBe(false);
  });

  it("allows requests again once the window has fully elapsed", async () => {
    const key = "user-d";
    const options = { windowMs: 20, maxRequests: 1 };
    expect(checkRateLimit(key, options).allowed).toBe(true);
    expect(checkRateLimit(key, options).allowed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(checkRateLimit(key, options).allowed).toBe(true);
  });
});
