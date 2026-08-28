import { describe, expect, it } from "vitest";
import { buildCashFlowForecast, estimateAverageDailyDiscretionarySpend } from "./cash-flow-forecast";
import { agorot } from "./money";

function date(iso: string): Date {
  return new Date(iso);
}

describe("buildCashFlowForecast()", () => {
  it("produces exactly `horizonDays` entries, defaulting to 60", () => {
    const forecast = buildCashFlowForecast({
      startingBalance: agorot(100_000),
      startDate: date("2026-08-01"),
      recurringItems: [],
      averageDailyDiscretionarySpend: agorot(0),
    });
    expect(forecast.days).toHaveLength(60);
  });

  it("respects a custom horizon", () => {
    const forecast = buildCashFlowForecast({
      startingBalance: agorot(100_000),
      startDate: date("2026-08-01"),
      horizonDays: 10,
      recurringItems: [],
      averageDailyDiscretionarySpend: agorot(0),
    });
    expect(forecast.days).toHaveLength(10);
  });

  it("applies the flat discretionary rate every day with no recurring items", () => {
    const forecast = buildCashFlowForecast({
      startingBalance: agorot(100_000),
      startDate: date("2026-08-01"),
      horizonDays: 5,
      recurringItems: [],
      averageDailyDiscretionarySpend: agorot(-1_000),
    });
    expect(forecast.days.map((d) => d.projectedBalance)).toEqual([99_000, 98_000, 97_000, 96_000, 95_000]);
    expect(forecast.endingBalance).toBe(95_000);
  });

  it("does not fire an event when the next projected occurrence falls outside the window", () => {
    const forecast = buildCashFlowForecast({
      startingBalance: agorot(100_000),
      startDate: date("2026-08-01"),
      horizonDays: 10,
      recurringItems: [
        {
          merchantKey: "netflix",
          amount: agorot(-5_000),
          averageIntervalDays: 30,
          // Last occurred well before the window; next projected
          // occurrence is 2026-08-14, past the 10-day (-> 8/11) window.
          lastOccurredAt: date("2026-07-15"),
        },
      ],
      averageDailyDiscretionarySpend: agorot(0),
    });
    expect(forecast.days.every((d) => d.events.length === 0)).toBe(true);
    expect(forecast.endingBalance).toBe(100_000);
  });

  it("projects a recurring item's next occurrence inside the window and applies it on that day", () => {
    const forecast = buildCashFlowForecast({
      startingBalance: agorot(100_000),
      startDate: date("2026-08-01"),
      horizonDays: 10,
      recurringItems: [
        {
          merchantKey: "weekly-cleaner",
          amount: agorot(-2_000),
          averageIntervalDays: 5,
          lastOccurredAt: date("2026-07-30"), // next: 8/4 (day 3), then 8/9 (day 8)
        },
      ],
      averageDailyDiscretionarySpend: agorot(0),
    });

    const eventDays = forecast.days.filter((d) => d.events.length > 0).map((d) => d.date.toISOString().slice(0, 10));
    expect(eventDays).toEqual(["2026-08-04", "2026-08-09"]);
    // Two occurrences of -2,000 applied by the end of the window.
    expect(forecast.endingBalance).toBe(96_000);
  });

  it("finds the absolute minimum point, which can be before the ending balance recovers", () => {
    const forecast = buildCashFlowForecast({
      startingBalance: agorot(10_000),
      startDate: date("2026-08-01"),
      horizonDays: 10,
      recurringItems: [
        { merchantKey: "rent", amount: agorot(-9_000), averageIntervalDays: 30, lastOccurredAt: date("2026-07-05") }, // next: 2026-08-04, day 3
        { merchantKey: "salary", amount: agorot(15_000), averageIntervalDays: 30, lastOccurredAt: date("2026-07-08") }, // next: 2026-08-07, day 6
      ],
      averageDailyDiscretionarySpend: agorot(0),
    });

    // Balance: flat 10,000 until day 3 (-9,000 -> 1,000), flat until day 6 (+15,000 -> 16,000), flat to the end.
    expect(forecast.minimum.balance).toBe(1_000);
    expect(forecast.minimum.date.toISOString().slice(0, 10)).toBe("2026-08-04");
    expect(forecast.endingBalance).toBe(16_000);
    expect(forecast.endingBalance).toBeGreaterThan(forecast.minimum.balance);
  });

  it("rejects a non-positive averageIntervalDays", () => {
    expect(() =>
      buildCashFlowForecast({
        startingBalance: agorot(0),
        startDate: date("2026-08-01"),
        recurringItems: [
          { merchantKey: "bad", amount: agorot(-100), averageIntervalDays: 0, lastOccurredAt: date("2026-08-01") },
        ],
        averageDailyDiscretionarySpend: agorot(0),
      }),
    ).toThrow(RangeError);
  });
});

describe("estimateAverageDailyDiscretionarySpend()", () => {
  it("divides the total by the historical window", () => {
    expect(estimateAverageDailyDiscretionarySpend([agorot(-1_000), agorot(-2_000)], 30)).toBe(-100);
  });

  it("rejects a non-positive window", () => {
    expect(() => estimateAverageDailyDiscretionarySpend([agorot(-100)], 0)).toThrow(RangeError);
  });
});
