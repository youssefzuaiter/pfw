import { afterEach, describe, expect, it } from "vitest";
import { checkLoginRateLimit } from "./credentials";
import { _resetRateLimitsForTests } from "../api/rate-limit";

/**
 * Login-lockout coverage (auth hardening pass, ad hoc post-§3ff) — the
 * rate-limiter itself is already unit-tested (`rate-limit.test.ts`), so
 * this only pins down `checkLoginRateLimit`'s own wiring: keyed by
 * email, case/whitespace-insensitively, independent across distinct
 * emails.
 */
describe("checkLoginRateLimit()", () => {
  afterEach(() => {
    _resetRateLimitsForTests();
  });

  it("allows attempts under the limit", () => {
    for (let i = 0; i < 10; i++) {
      expect(checkLoginRateLimit("locked-out-test@pfw.local")).toBe(true);
    }
  });

  it("blocks the 11th attempt within the window for the same email", () => {
    for (let i = 0; i < 10; i++) {
      checkLoginRateLimit("locked-out-test-2@pfw.local");
    }
    expect(checkLoginRateLimit("locked-out-test-2@pfw.local")).toBe(false);
  });

  it("normalizes email case/whitespace so a variant address shares the same bucket", () => {
    for (let i = 0; i < 10; i++) {
      checkLoginRateLimit("Case-Test@PFW.local");
    }
    expect(checkLoginRateLimit("  case-test@pfw.local  ")).toBe(false);
  });

  it("tracks a different email independently", () => {
    for (let i = 0; i < 10; i++) {
      checkLoginRateLimit("account-a@pfw.local");
    }
    expect(checkLoginRateLimit("account-a@pfw.local")).toBe(false);
    expect(checkLoginRateLimit("account-b@pfw.local")).toBe(true);
  });
});
