import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { checkLoginRateLimit } from "./credentials";
import { _resetRateLimitsForTests } from "../api/rate-limit";

/**
 * Login-lockout coverage (auth hardening pass, ad hoc post-§3ff) — the
 * rate-limiter itself is already unit-tested (`rate-limit.test.ts`), so
 * this only pins down `checkLoginRateLimit`'s own wiring: keyed by
 * email, case/whitespace-insensitively, independent across distinct
 * emails.
 *
 * Forces the limiter's in-memory store: this is a unit test and must
 * never depend on a database, even when the shell running it has
 * `APP_DATABASE_URL` exported (the Postgres-backed store is covered by
 * `tests/integration/rate-limit-buckets.test.ts`).
 */
describe("checkLoginRateLimit()", () => {
  beforeAll(() => {
    process.env.RATE_LIMIT_STORE = "memory";
  });

  afterEach(async () => {
    await _resetRateLimitsForTests("auth:login:");
  });

  it("allows attempts under the limit", async () => {
    for (let i = 0; i < 10; i++) {
      expect(await checkLoginRateLimit("locked-out-test@pfw.local")).toBe(true);
    }
  });

  it("blocks the 11th attempt within the window for the same email", async () => {
    for (let i = 0; i < 10; i++) {
      await checkLoginRateLimit("locked-out-test-2@pfw.local");
    }
    expect(await checkLoginRateLimit("locked-out-test-2@pfw.local")).toBe(false);
  });

  it("normalizes email case/whitespace so a variant address shares the same bucket", async () => {
    for (let i = 0; i < 10; i++) {
      await checkLoginRateLimit("Case-Test@PFW.local");
    }
    expect(await checkLoginRateLimit("  case-test@pfw.local  ")).toBe(false);
  });

  it("tracks a different email independently", async () => {
    for (let i = 0; i < 10; i++) {
      await checkLoginRateLimit("account-a@pfw.local");
    }
    expect(await checkLoginRateLimit("account-a@pfw.local")).toBe(false);
    expect(await checkLoginRateLimit("account-b@pfw.local")).toBe(true);
  });
});
