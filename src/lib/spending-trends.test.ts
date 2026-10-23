import { describe, expect, it } from "vitest";
import { ILS_REPORTING } from "./reporting-currency";
import { buildSpendingTrends, type TrendFlow } from "./spending-trends";

const flow = (categoryId: string, iso: string, agorot: number): TrendFlow => ({ categoryId, occurredAt: new Date(`${iso}T12:00:00Z`), amount: -agorot });
const trends = (flows: TrendFlow[], asOf = "2026-10-12") => buildSpendingTrends({ flows, context: ILS_REPORTING, asOf: new Date(`${asOf}T09:00:00Z`) });
const row = (result: ReturnType<typeof trends>, id: string) => result.categories.find((c) => c.categoryId === id)!;

describe("buildSpendingTrends", () => {
  it("compares this month so far with the same days of the months before, not their whole month", () => {
    // Today is the 12th. Dining: 100 this month by the 12th; earlier months spent 100 by the 12th and 900 more after it.
    const flows = [
      flow("dining", "2026-10-05", 10_000),
      flow("dining", "2026-09-05", 10_000),
      flow("dining", "2026-09-20", 90_000),
      flow("dining", "2026-08-05", 10_000),
      flow("dining", "2026-08-25", 90_000),
      flow("dining", "2026-07-05", 10_000),
      flow("dining", "2026-07-28", 90_000),
    ];
    const result = trends(flows);
    expect(row(result, "dining")).toMatchObject({ thisMonth: 10_000, usualByNow: 10_000, difference: 0, differenceBps: 0, lastMonth: 100_000 });
    expect(result.thisMonth).toBe(10_000);
    expect(result.usualByNow).toBe(10_000);
  });

  it("shows a rise and a fall against the usual, with the percentage", () => {
    const flows = [
      flow("dining", "2026-10-03", 30_000),
      flow("dining", "2026-09-03", 20_000),
      flow("dining", "2026-08-03", 20_000),
      flow("dining", "2026-07-03", 20_000),
      flow("fuel", "2026-10-04", 5_000),
      flow("fuel", "2026-09-04", 10_000),
      flow("fuel", "2026-08-04", 10_000),
      flow("fuel", "2026-07-04", 10_000),
    ];
    const result = trends(flows);
    expect(row(result, "dining")).toMatchObject({ difference: 10_000, differenceBps: 5_000 });
    expect(row(result, "fuel")).toMatchObject({ difference: -5_000, differenceBps: -5_000 });
    expect(result.biggestRises.map((c) => c.categoryId)).toEqual(["dining"]);
    expect(result.biggestFalls.map((c) => c.categoryId)).toEqual(["fuel"]);
    expect(result.difference).toBe(5_000);
    expect(result.differenceBps).toBe(1_667);
  });

  it("a category with no earlier spending has no percentage, and one that stopped is a fall to nothing", () => {
    const flows = [
      flow("new", "2026-10-02", 7_000),
      flow("old", "2026-09-02", 4_000),
      flow("old", "2026-08-02", 4_000),
      flow("old", "2026-07-02", 4_000),
      flow("base", "2026-09-02", 1_000),
    ];
    const result = trends(flows);
    expect(row(result, "new")).toMatchObject({ thisMonth: 7_000, usualByNow: 0, difference: 7_000, differenceBps: null });
    // "old" averaged over the 3 earlier months that had any spending (base only spent in one, but the months count).
    expect(row(result, "old")).toMatchObject({ thisMonth: 0, difference: -row(result, "old").usualByNow });
    expect(result.biggestFalls.map((c) => c.categoryId)).toContain("old");
  });

  it("uses only the earlier months that had spending, so a new account is not compared against empty months", () => {
    const flows = [flow("dining", "2026-10-03", 5_000), flow("dining", "2026-09-03", 8_000)];
    const result = trends(flows);
    expect(result.baselineMonthsUsed).toBe(1);
    expect(row(result, "dining").usualByNow).toBe(8_000);
    const none = trends([flow("dining", "2026-10-03", 5_000)]);
    expect(none.baselineMonthsUsed).toBe(0);
    expect(row(none, "dining")).toMatchObject({ usualByNow: 0, differenceBps: null });
  });

  it("ignores income and months outside the window", () => {
    const flows = [
      { categoryId: "salary", occurredAt: new Date("2026-10-01T12:00:00Z"), amount: 500_000 },
      flow("dining", "2026-04-03", 99_999),
      flow("dining", "2026-10-03", 1_000),
    ];
    const result = trends(flows);
    expect(result.categories.map((c) => c.categoryId)).toEqual(["dining"]);
    expect(result.months).toHaveLength(6);
    expect(result.months.map((m) => m.monthKey)).toEqual(["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
  });

  it("a month and its categories always add up, in any currency", () => {
    const flows = [flow("a", "2026-10-02", 333), flow("b", "2026-10-03", 667), flow("a", "2026-09-02", 1_001)];
    const result = trends(flows);
    const current = result.months[result.months.length - 1];
    expect(result.categories.reduce((sum, c) => sum + c.thisMonth, 0)).toBe(current.spendSameDays);
    const usd = { currency: "USD" as const, ilsPerUnit: 3, latestMicros: 3_000_000, rateDay: "2026-10-01", history: [] };
    const inDollars = buildSpendingTrends({ flows, context: usd, asOf: new Date("2026-10-12T09:00:00Z") });
    expect(inDollars.categories.reduce((sum, c) => sum + c.thisMonth, 0)).toBe(inDollars.months[inDollars.months.length - 1].spendSameDays);
  });

  it("a short month's days are capped, and the 31st compares with whole shorter months", () => {
    // On 31 October, February-style short months are compared in full.
    const flows = [flow("dining", "2026-10-31", 5_000), flow("dining", "2026-09-30", 4_000), flow("dining", "2026-08-31", 6_000), flow("dining", "2026-07-31", 5_000)];
    const result = trends(flows, "2026-10-31");
    expect(row(result, "dining")).toMatchObject({ thisMonth: 5_000, usualByNow: 5_000 });
  });

  it("rounds a percentage half away from zero, both ways", () => {
    // usual 3, now 4: +33.33% -> 3333; usual 3, now 2: -33.33% -> -3333; usual 8, now 9: 12.5% -> 1250
    const rise = trends([flow("x", "2026-10-02", 4), flow("x", "2026-09-02", 3), flow("x", "2026-08-02", 3), flow("x", "2026-07-02", 3)]);
    expect(row(rise, "x").differenceBps).toBe(3_333);
    const fall = trends([flow("x", "2026-10-02", 2), flow("x", "2026-09-02", 3), flow("x", "2026-08-02", 3), flow("x", "2026-07-02", 3)]);
    expect(row(fall, "x").differenceBps).toBe(-3_333);
    const half = trends([flow("x", "2026-10-02", 9), flow("x", "2026-09-02", 8), flow("x", "2026-08-02", 8), flow("x", "2026-07-02", 8)]);
    expect(row(half, "x").differenceBps).toBe(1_250);
  });
});
