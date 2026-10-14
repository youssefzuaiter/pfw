import { describe, expect, it } from "vitest";
import { createSeededRandom } from "./monte-carlo";
import { agorot, formatAgorot } from "./money";
import {
  ILS_REPORTING,
  describeReportingRate,
  describeReportingRateRule,
  flowInReporting,
  formatReportingAmount,
  formatReportingAmountOn,
  formatReportingMinorUnits,
  incomeExpenseByMonthInReporting,
  isConvertedReporting,
  spendByCategoryInReporting,
  sumFlowsInReporting,
  toReportingMinorUnits,
  toReportingMinorUnitsOn,
  type CategorizedFlow,
  type ReportingContext,
} from "./reporting-currency";

function context(currency: ReportingContext["currency"], ilsPerUnit: number, history: ReportingContext["history"] = [], rateDay: string | null = "2026-10-12"): ReportingContext {
  return { currency, ilsPerUnit, latestMicros: Math.round(ilsPerUnit * 1_000_000), rateDay, history };
}

const USD = context("USD", 3.7);

describe("reporting currency at today's rate", () => {
  it("is exactly formatAgorot for ILS, whatever the amount", () => {
    for (const value of [0, 1, -1, 12_550, -1_234_567, 999_999_999]) {
      expect(formatReportingAmount(agorot(value), ILS_REPORTING)).toBe(formatAgorot(agorot(value)));
      expect(formatReportingAmount(agorot(value), ILS_REPORTING, { showPositiveSign: true })).toBe(
        formatAgorot(agorot(value), { showPositiveSign: true }),
      );
    }
    expect(isConvertedReporting(ILS_REPORTING)).toBe(false);
    expect(describeReportingRate(ILS_REPORTING)).toBeNull();
    expect(describeReportingRateRule(ILS_REPORTING)).toBeNull();
  });

  it("converts at ILS per unit and shows the currency's own symbol", () => {
    // ₪370.00 at ₪3.70 per $1 is exactly $100.00.
    expect(formatReportingAmount(agorot(37_000), USD)).toBe("$100.00");
    expect(toReportingMinorUnits(agorot(37_000), USD)).toBe(10_000);
    expect(formatReportingAmount(agorot(-1_234_567), USD)).toBe("-$3,336.67");
    expect(formatReportingAmount(agorot(37_000), USD, { showPositiveSign: true })).toBe("+$100.00");
    expect(formatReportingAmount(agorot(0), USD, { showPositiveSign: true })).toBe("$0.00");
    expect(isConvertedReporting(USD)).toBe(true);
  });

  it("rounds half away from zero, the same both ways", () => {
    // At ₪2 per €1, every odd agorot amount lands exactly on half a cent.
    const exactHalf = context("EUR", 2, [], null);
    expect(toReportingMinorUnits(agorot(1), exactHalf)).toBe(1);
    expect(toReportingMinorUnits(agorot(-1), exactHalf)).toBe(-1);
    expect(toReportingMinorUnits(agorot(3), exactHalf)).toBe(2);
    expect(toReportingMinorUnits(agorot(-3), exactHalf)).toBe(-2);
  });

  it("formats minor units that are already in the reporting currency, rounding any fraction", () => {
    expect(formatReportingMinorUnits(10_000, USD)).toBe("$100.00");
    expect(formatReportingMinorUnits(-250.4, USD)).toBe("-$2.50");
    expect(formatReportingMinorUnits(12_550, ILS_REPORTING)).toBe("₪125.50");
    expect(formatReportingMinorUnits(15, context("TRY", 0.09, [], null))).toBe("₺0.15");
  });

  it("says which rate it used, and says so when the rate is only a fallback", () => {
    expect(describeReportingRate(USD)).toBe("₪3.7000 per $1, rate of 2026-10-12");
    expect(describeReportingRate(context("TRY", 0.0623, [], null))).toBe("₪0.0623 per ₺1, an approximate rate (none synced yet)");
  });
});

describe("reporting currency on the day money moved", () => {
  // Friday 28 August at 3.0, Monday 31 August at 4.0; today's rate is 5.0.
  const DATED = context("USD", 5, [
    { day: "2026-08-28", micros: 3_000_000 },
    { day: "2026-08-31", micros: 4_000_000 },
    { day: "2026-09-01", micros: 2_000_000 },
  ]);

  it("converts at the rate of the money's own day, and the weekend at Friday's", () => {
    expect(toReportingMinorUnitsOn(agorot(-30_000), "2026-08-28T12:00:00Z", DATED)).toBe(-10_000);
    expect(toReportingMinorUnitsOn(agorot(-30_000), "2026-08-30T22:00:00Z", DATED)).toBe(-10_000); // Sunday → Friday
    expect(toReportingMinorUnitsOn(agorot(-40_000), "2026-08-31T09:00:00Z", DATED)).toBe(-10_000);
    expect(toReportingMinorUnits(agorot(-50_000), DATED)).toBe(-10_000); // today's rate for balances
    expect(formatReportingAmountOn(agorot(30_000), new Date("2026-08-29T00:00:00Z"), DATED)).toBe("$100.00");
  });

  it("puts 23:59 and 00:01 on either side of midnight UTC in different days and different months", () => {
    const flows = [
      { amount: -30_000, occurredAt: "2026-08-31T23:59:00Z" }, // Monday 31 Aug at 4.0 → -$75.00, August
      { amount: -30_000, occurredAt: "2026-09-01T00:01:00Z" }, // Tuesday 1 Sep at 2.0 → -$150.00, September
    ];
    expect(flows.map((flow) => flowInReporting(flow, DATED))).toEqual([-7_500, -15_000]);
    const months = incomeExpenseByMonthInReporting(flows, DATED);
    expect(months.get("2026-08")).toEqual({ income: 0, expense: 7_500 });
    expect(months.get("2026-09")).toEqual({ income: 0, expense: 15_000 });
  });

  it("uses a transaction's own amount when it happened in the reporting currency", () => {
    expect(flowInReporting({ amount: -37_123, occurredAt: "2026-08-28", currency: "USD", nativeAmount: -10_033 }, DATED)).toBe(-10_033);
    // Another foreign currency converts through its frozen shekel amount.
    expect(flowInReporting({ amount: -30_000, occurredAt: "2026-08-28", currency: "EUR", nativeAmount: -9_000 }, DATED)).toBe(-10_000);
    // Shekel reporting is the shekel amount, whatever the transaction's currency.
    expect(flowInReporting({ amount: -37_123, occurredAt: "2026-08-28", currency: "USD", nativeAmount: -10_033 }, ILS_REPORTING)).toBe(-37_123);
  });

  it("is the stored agorot exactly for ILS, sums included", () => {
    const flows = [
      { amount: 1_000_000n, occurredAt: "2026-08-28" },
      { amount: -12_345n, occurredAt: "2026-08-31" },
      { amount: -1n, occurredAt: "2026-09-01" },
    ];
    expect(sumFlowsInReporting(flows, ILS_REPORTING)).toBe(987_654);
    expect(incomeExpenseByMonthInReporting(flows, ILS_REPORTING).get("2026-08")).toEqual({ income: 1_000_000, expense: 12_345 });
  });

  it("adds up the same however a period is sliced: totals equal the sum of categories, of months, of days", () => {
    const random = createSeededRandom(20261014);
    const categories = ["groceries", "dining", "rent", "transport"];
    const reporting = context(
      "USD",
      3.7,
      Array.from({ length: 120 }, (_, i) => ({
        day: new Date(Date.UTC(2026, 5, 1) + i * 86_400_000).toISOString().slice(0, 10),
        micros: 3_000_000 + Math.floor(random() * 900_000),
      })).filter((point) => ![0, 6].includes(new Date(`${point.day}T00:00:00Z`).getUTCDay())),
    );
    const flows: CategorizedFlow[] = Array.from({ length: 2_000 }, () => ({
      amount: -Math.floor(random() * 500_000) - 1,
      occurredAt: new Date(Date.UTC(2026, 5, 1) + Math.floor(random() * 120 * 86_400_000)),
      categoryId: categories[Math.floor(random() * categories.length)],
    }));

    const total = -sumFlowsInReporting(flows, reporting);
    const byCategory = [...spendByCategoryInReporting(flows, reporting).values()].reduce((sum, value) => sum + value, 0);
    const byMonth = [...incomeExpenseByMonthInReporting(flows, reporting).values()].reduce((sum, month) => sum + month.expense, 0);
    const byDay = new Map<string, CategorizedFlow[]>();
    for (const flow of flows) {
      const day = (flow.occurredAt as Date).toISOString().slice(0, 10);
      byDay.set(day, [...(byDay.get(day) ?? []), flow]);
    }
    const sumOfDays = [...byDay.values()].reduce((sum, day) => sum - sumFlowsInReporting(day, reporting), 0);

    expect(byCategory).toBe(total);
    expect(byMonth).toBe(total);
    expect(sumOfDays).toBe(total);
    // And the order the transactions are added in changes nothing.
    expect(-sumFlowsInReporting([...flows].reverse(), reporting)).toBe(total);
  });

  it("ignores income in category spending, and keeps months' income and expense apart", () => {
    const flows: CategorizedFlow[] = [
      { amount: 60_000, occurredAt: "2026-08-28", categoryId: "salary" },
      { amount: -30_000, occurredAt: "2026-08-28", categoryId: "groceries" },
    ];
    expect([...spendByCategoryInReporting(flows, DATED)]).toEqual([["groceries", 10_000]]);
    expect(incomeExpenseByMonthInReporting(flows, DATED).get("2026-08")).toEqual({ income: 20_000, expense: 10_000 });
  });

  it("says which rule it used, and from when rates are stored", () => {
    expect(describeReportingRateRule(DATED)).toMatch(/rate of their own day/);
    expect(describeReportingRateRule(DATED)).toMatch(/stored from 2026-08-28/);
    expect(describeReportingRateRule(context("USD", 3.7))).not.toMatch(/stored from/);
  });
});
