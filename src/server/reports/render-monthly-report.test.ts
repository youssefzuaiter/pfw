import { describe, expect, it } from "vitest";
import { renderMonthlyReport } from "./render-monthly-report";
import type { MonthlyReportData } from "./monthly-report";

const BASE: MonthlyReportData = {
  monthKey: "2026-09",
  incomeAgorot: 1_672_783n,
  expenseAgorot: 1_250_000n,
  // In shekels the figures shown are the stored agorot (AGENTS.md §3vvv).
  incomeShown: 1_672_783,
  expenseShown: 1_250_000,
  topCategories: [
    { name: "Groceries", spentAgorot: 600_000n, spentShown: 600_000 },
    { name: "Dining", spentAgorot: 250_050n, spentShown: 250_050 },
  ],
  netWorth: { startAgorot: 3_000_000n, endAgorot: 3_120_000n, startShown: 3_000_000, endShown: 3_120_000 },
  core: null,
};

describe("renderMonthlyReport", () => {
  it("names the month in the subject and lists income, spending and the signed net", () => {
    const { subject, text } = renderMonthlyReport(BASE, "https://pfw.example");
    expect(subject).toBe("Your PFW summary for September 2026");
    expect(text).toContain("Income: ₪16,727.83");
    expect(text).toContain("Spending: ₪12,500.00");
    expect(text).toContain("Net: +₪4,227.83");
    expect(text).toContain("Groceries: ₪6,000.00");
    expect(text).toContain("Dining: ₪2,500.50");
    expect(text).toContain("Change: +₪1,200.00");
    expect(text).toContain("See the full review: https://pfw.example/review?month=2026-09");
  });

  it("says what is missing instead of inventing a figure", () => {
    const { text } = renderMonthlyReport({ ...BASE, topCategories: [], netWorth: null }, "https://pfw.example/");
    expect(text).toContain("No spending recorded this month.");
    expect(text).toContain("Not enough history yet");
    expect(text).not.toContain("Start of month");
    expect(text).toContain("https://pfw.example/review?month=2026-09"); // a trailing slash on the origin is not doubled
  });

  it("adds the core section only when there is core data, with the change as a percent", () => {
    expect(renderMonthlyReport(BASE, "https://pfw.example").text).not.toContain("Long-term core");

    const { text } = renderMonthlyReport({ ...BASE, core: { startUsdCents: 999_858, endUsdCents: 1_009_856 } }, "https://pfw.example");
    expect(text).toContain("Long-term core (paper account)");
    expect(text).toContain("Start of month: $9,998.58");
    expect(text).toContain("Change: +$99.98 (+1.00%)");
  });

  it("escapes every value in the HTML, including the user's own category names", () => {
    const { html } = renderMonthlyReport(
      { ...BASE, topCategories: [{ name: '<img src=x onerror="alert(1)">', spentAgorot: 100n, spentShown: 100 }] },
      "https://pfw.example",
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain('<a href="https://pfw.example/review?month=2026-09">');
  });

  it("shows a loss with a minus sign", () => {
    const { text } = renderMonthlyReport(
      { ...BASE, incomeAgorot: 0n, incomeShown: 0, netWorth: { startAgorot: 500_000n, endAgorot: 400_000n, startShown: 500_000, endShown: 400_000 } },
      "https://pfw.example",
    );
    expect(text).toContain("Net: -₪12,500.00");
    expect(text).toContain("Change: -₪1,000.00");
  });

  it("shows the reporting-currency figures it is given, never converting them again, and says which rates were used", () => {
    const { text, html } = renderMonthlyReport(
      {
        ...BASE,
        // What gatherMonthlyReport computes: each transaction at its own day's rate, then added.
        incomeShown: 452_104,
        expenseShown: 337_838,
        topCategories: [{ name: "Groceries", spentAgorot: 600_000n, spentShown: 162_162 }],
        netWorth: { startAgorot: 3_000_000n, endAgorot: 3_120_000n, startShown: 81_081, endShown: 84_324 },
        reporting: { currency: "USD", ilsPerUnit: 3.7, latestMicros: 3_700_000, rateDay: "2026-09-30", history: [{ day: "2026-09-01", micros: 3_650_000 }] },
      },
      "https://pfw.example",
    );
    expect(text).toContain("Income: $4,521.04");
    expect(text).toContain("Spending: $3,378.38");
    expect(text).toContain("Net: +$1,142.66");
    expect(text).toContain("Groceries: $1,621.62");
    expect(text).toContain("Change: +$32.43");
    expect(text).not.toContain("₪16,727.83");
    expect(text).toContain("Today's rate is ₪3.7000 per $1, rate of 2026-09-30.");
    expect(text).toContain("use the rate of their own day");
    expect(html).toContain("Today's rate is ₪3.7000 per $1");
  });

  it("adds no rate note in shekels", () => {
    expect(renderMonthlyReport(BASE, "https://pfw.example").text).not.toContain("rate");
  });
});
