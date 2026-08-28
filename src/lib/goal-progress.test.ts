import { describe, expect, it } from "vitest";
import { agorot } from "./money";
import { summarizeGoalProgress } from "./goal-progress";

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
