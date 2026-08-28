import { describe, expect, it } from "vitest";
import { agorot } from "../money";
import { generateGoalPaceInsights } from "./goal-pace";

describe("generateGoalPaceInsights()", () => {
  it("flags a goal that's significantly behind the pace needed to hit its target date", () => {
    const insights = generateGoalPaceInsights([
      {
        goalId: "goal-1",
        goalName: "Emergency Fund",
        targetAmount: agorot(100_000),
        currentAmount: agorot(10_000), // only 10% after half the timeline
        startDate: new Date("2026-01-01"),
        targetDate: new Date("2027-01-01"),
        today: new Date("2026-07-01"),
      },
    ]);
    expect(insights).toHaveLength(1);
    expect(insights[0].type).toBe("goal_off_pace");
  });

  it("does not flag a goal that's on or ahead of pace", () => {
    const insights = generateGoalPaceInsights([
      {
        goalId: "goal-2",
        goalName: "Vacation",
        targetAmount: agorot(100_000),
        currentAmount: agorot(55_000), // ahead of the ~50% expected at the halfway point
        startDate: new Date("2026-01-01"),
        targetDate: new Date("2027-01-01"),
        today: new Date("2026-07-01"),
      },
    ]);
    expect(insights).toHaveLength(0);
  });

  it("does not flag an already-completed goal", () => {
    const insights = generateGoalPaceInsights([
      {
        goalId: "goal-3",
        goalName: "Done",
        targetAmount: agorot(100_000),
        currentAmount: agorot(150_000),
        startDate: new Date("2026-01-01"),
        targetDate: new Date("2026-06-01"),
        today: new Date("2026-08-01"),
      },
    ]);
    expect(insights).toHaveLength(0);
  });

  it("flags an incomplete goal that's past its target date as critical", () => {
    const insights = generateGoalPaceInsights([
      {
        goalId: "goal-4",
        goalName: "Missed Goal",
        targetAmount: agorot(100_000),
        currentAmount: agorot(40_000),
        startDate: new Date("2026-01-01"),
        targetDate: new Date("2026-06-01"),
        today: new Date("2026-08-01"),
      },
    ]);
    expect(insights).toHaveLength(1);
    expect(insights[0].severity).toBe("critical");
    expect(insights[0].title).toMatch(/past its target date/);
  });

  it("skips a goal with no target date", () => {
    const insights = generateGoalPaceInsights([
      {
        goalId: "goal-5",
        goalName: "Open-ended",
        targetAmount: agorot(100_000),
        currentAmount: agorot(1_000),
        startDate: new Date("2026-01-01"),
        today: new Date("2026-08-01"),
      },
    ]);
    expect(insights).toHaveLength(0);
  });

  it("escalates to critical when severely behind pace", () => {
    const insights = generateGoalPaceInsights([
      {
        goalId: "goal-6",
        goalName: "Way Behind",
        targetAmount: agorot(100_000),
        currentAmount: agorot(1_000),
        startDate: new Date("2026-01-01"),
        targetDate: new Date("2027-01-01"),
        today: new Date("2026-07-01"),
      },
    ]);
    expect(insights[0].severity).toBe("critical");
  });
});
