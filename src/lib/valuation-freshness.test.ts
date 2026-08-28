import { describe, expect, it } from "vitest";
import { deriveValuationFreshness } from "./valuation-freshness";

const now = new Date("2026-08-27T00:00:00Z");
function daysAgo(days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

describe("deriveValuationFreshness()", () => {
  it("is fresh at exactly 0 days", () => {
    expect(deriveValuationFreshness(now, now)).toBe("fresh");
  });

  it("is fresh at the 30-day boundary", () => {
    expect(deriveValuationFreshness(daysAgo(30), now)).toBe("fresh");
  });

  it("is aging just past the 30-day boundary", () => {
    expect(deriveValuationFreshness(daysAgo(31), now)).toBe("aging");
  });

  it("is aging at the 90-day boundary", () => {
    expect(deriveValuationFreshness(daysAgo(90), now)).toBe("aging");
  });

  it("is stale just past the 90-day boundary", () => {
    expect(deriveValuationFreshness(daysAgo(91), now)).toBe("stale");
  });

  it("is stale for a very old valuation", () => {
    expect(deriveValuationFreshness(daysAgo(400), now)).toBe("stale");
  });
});
