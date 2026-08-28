import { describe, expect, it } from "vitest";
import { agorot } from "./money";
import { computeMonthProgress, computeProrationStatus } from "./budget-proration";

describe("computeMonthProgress()", () => {
  it("is a fraction near 0 on the 1st of a 30-day month", () => {
    expect(computeMonthProgress(new Date("2026-09-01T00:00:00Z"))).toBeCloseTo(1 / 30, 5);
  });

  it("is 1 on the last day of the month", () => {
    expect(computeMonthProgress(new Date("2026-09-30T00:00:00Z"))).toBe(1);
  });

  it("accounts for a 31-day month correctly", () => {
    expect(computeMonthProgress(new Date("2026-08-31T00:00:00Z"))).toBe(1);
  });

  it("is about half at mid-month", () => {
    expect(computeMonthProgress(new Date("2026-09-15T00:00:00Z"))).toBeCloseTo(0.5, 1);
  });
});

describe("computeProrationStatus()", () => {
  it("is on_pace when spend tracks the elapsed month fraction", () => {
    expect(computeProrationStatus(agorot(500), agorot(1_000), 0.5)).toBe("on_pace");
  });

  it("is over_pace when spend is well ahead of the elapsed month fraction", () => {
    expect(computeProrationStatus(agorot(900), agorot(1_000), 0.3)).toBe("over_pace");
  });

  it("is under_pace when spend is well behind the elapsed month fraction", () => {
    expect(computeProrationStatus(agorot(100), agorot(1_000), 0.8)).toBe("under_pace");
  });

  it("treats a small deviation within tolerance as on_pace", () => {
    expect(computeProrationStatus(agorot(550), agorot(1_000), 0.5)).toBe("on_pace");
  });

  it("does not divide by zero for a zero-limit budget", () => {
    expect(computeProrationStatus(agorot(0), agorot(0), 0.5)).toBe("on_pace");
  });
});
