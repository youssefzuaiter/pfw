import { describe, expect, it } from "vitest";
import { agorot } from "./money";
import { projectCompletionDate, summarizeGoalProgress } from "./goal-progress";

describe("summarizeGoalProgress()", () => {
  it("is complete once the current amount reaches the target", () => {
    const summary = summarizeGoalProgress({
      targetAmount: agorot(100_000),
      currentAmount: agorot(100_000),
      startDate: new Date("2026-01-01"),
      today: new Date("2026-06-01"),
    });
    expect(summary.status).toBe("complete");
    expect(summary.projectedCompletionDate).toBeNull();
  });

  it("is no_target_date when there's no deadline to pace against", () => {
    const summary = summarizeGoalProgress({
      targetAmount: agorot(100_000),
      currentAmount: agorot(10_000),
      startDate: new Date("2026-01-01"),
      today: new Date("2026-06-01"),
    });
    expect(summary.status).toBe("no_target_date");
  });

  it("is overdue when past the target date and still incomplete", () => {
    const summary = summarizeGoalProgress({
      targetAmount: agorot(100_000),
      currentAmount: agorot(40_000),
      startDate: new Date("2026-01-01"),
      targetDate: new Date("2026-06-01"),
      today: new Date("2026-08-01"),
    });
    expect(summary.status).toBe("overdue");
  });

  it("is ahead when comfortably beating the required pace", () => {
    const summary = summarizeGoalProgress({
      targetAmount: agorot(100_000),
      currentAmount: agorot(70_000), // ~70% at the halfway point
      startDate: new Date("2026-01-01"),
      targetDate: new Date("2027-01-01"),
      today: new Date("2026-07-01"),
    });
    expect(summary.status).toBe("ahead");
  });

  it("is on_track when close to the required pace", () => {
    const summary = summarizeGoalProgress({
      targetAmount: agorot(100_000),
      currentAmount: agorot(50_000), // ~50% at the halfway point
      startDate: new Date("2026-01-01"),
      targetDate: new Date("2027-01-01"),
      today: new Date("2026-07-01"),
    });
    expect(summary.status).toBe("on_track");
  });

  it("is behind when well short of the required pace", () => {
    const summary = summarizeGoalProgress({
      targetAmount: agorot(100_000),
      currentAmount: agorot(5_000),
      startDate: new Date("2026-01-01"),
      targetDate: new Date("2027-01-01"),
      today: new Date("2026-07-01"),
    });
    expect(summary.status).toBe("behind");
  });

  it("computes a projected completion date from the rate achieved so far", () => {
    // 10,000 contributed in 100 days -> 100 agorot/day -> 100,000 target
    // takes 1,000 days from the start date.
    const startDate = new Date("2026-01-01T00:00:00Z");
    const summary = summarizeGoalProgress({
      targetAmount: agorot(100_000),
      currentAmount: agorot(10_000),
      startDate,
      today: new Date(startDate.getTime() + 100 * 24 * 60 * 60 * 1000),
    });
    const expected = new Date(startDate.getTime() + 1_000 * 24 * 60 * 60 * 1000);
    expect(summary.projectedCompletionDate?.getTime()).toBeCloseTo(expected.getTime(), -5);
  });

  it("has no projected completion date before any progress has been made", () => {
    const summary = summarizeGoalProgress({
      targetAmount: agorot(100_000),
      currentAmount: agorot(0),
      startDate: new Date("2026-01-01"),
      today: new Date("2026-01-01"),
    });
    expect(summary.projectedCompletionDate).toBeNull();
  });

  it("reports 0% progress for a zero-target goal without dividing by zero", () => {
    const summary = summarizeGoalProgress({
      targetAmount: agorot(0),
      currentAmount: agorot(0),
      startDate: new Date("2026-01-01"),
      today: new Date("2026-01-01"),
    });
    expect(summary.progressPercent).toBe(0);
  });
});

describe("projectCompletionDate()", () => {
  const startDate = new Date("2026-08-01T00:00:00Z");

  it("projects a representable completion date at a normal contribution rate", () => {
    // 25% done after 30 days -> ~120 total days.
    const projected = projectCompletionDate(startDate, 30, 0.25);
    expect(projected).not.toBeNull();
    expect(projected?.toISOString().slice(0, 10)).toBe("2026-11-29");
  });

  // Regression: this exact input produced `Invalid Date`, whose
  // `.toISOString()` throws `RangeError: Invalid time value` — crashing
  // /goals, /dashboard and the advisor's list_goals_with_progress tool.
  it("returns null instead of an unrepresentable Date when the rate is vanishingly small", () => {
    const completedFraction = 1 / 5_000_000; // ₪0.01 toward a ₪50,000 goal
    expect(projectCompletionDate(startDate, 30, completedFraction)).toBeNull();
  });

  it("returns null for a zero, negative, or non-finite completed fraction", () => {
    expect(projectCompletionDate(startDate, 30, 0)).toBeNull();
    expect(projectCompletionDate(startDate, 30, -0.5)).toBeNull();
    expect(projectCompletionDate(startDate, 30, Number.NaN)).toBeNull();
  });

  it("returns null before any time has elapsed", () => {
    expect(projectCompletionDate(startDate, 0, 0.5)).toBeNull();
  });

  it("never returns a Date that would throw on toISOString()", () => {
    const fractions = [1, 0.5, 1e-3, 1e-6, 1e-9, 1e-12, Number.MIN_VALUE];
    for (const fraction of fractions) {
      const projected = projectCompletionDate(startDate, 30, fraction);
      if (projected !== null) expect(() => projected.toISOString()).not.toThrow();
    }
  });
});
