import { describe, expect, it } from "vitest";
import { classifyFreshness } from "./build-ops-status-data";

const NOW = new Date("2026-09-22T12:00:00.000Z");

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000);
}

/**
 * The freshness buckets the ops page renders. Pure and separately
 * exported precisely so the boundaries can be pinned without a database
 * — the thresholds encode a real claim (the nightly cron is due every
 * 24h), and a silent off-by-one here would either cry wolf every morning
 * or stay green through a week of failed syncs.
 */
describe("classifyFreshness", () => {
  it("reports a never-synced source distinctly, not as infinitely stale", () => {
    expect(classifyFreshness(null, NOW)).toEqual({ ageHours: null, tier: "never" });
  });

  it("treats anything under 36h as fresh — a 24h cadence plus grace for a late run", () => {
    expect(classifyFreshness(hoursAgo(0), NOW).tier).toBe("fresh");
    expect(classifyFreshness(hoursAgo(25), NOW).tier).toBe("fresh");
    expect(classifyFreshness(hoursAgo(35.9), NOW).tier).toBe("fresh");
  });

  it("warns from exactly 36h — one missed run, not yet an alarm", () => {
    expect(classifyFreshness(hoursAgo(36), NOW).tier).toBe("warning");
    expect(classifyFreshness(hoursAgo(71.9), NOW).tier).toBe("warning");
  });

  it("goes critical from exactly 72h — two consecutive missed runs", () => {
    expect(classifyFreshness(hoursAgo(72), NOW).tier).toBe("critical");
    expect(classifyFreshness(hoursAgo(24 * 30), NOW).tier).toBe("critical");
  });

  it("reports the real age alongside the tier, so the page can show '3d ago' rather than only a colour", () => {
    expect(classifyFreshness(hoursAgo(48), NOW).ageHours).toBeCloseTo(48, 6);
  });

  it("does not go negative or throw for a timestamp slightly in the future (clock skew between the app and the database)", () => {
    const skewed = classifyFreshness(new Date(NOW.getTime() + 60_000), NOW);
    expect(skewed.tier).toBe("fresh");
    expect(skewed.ageHours).toBeLessThan(0);
  });
});
