import { describe, expect, it } from "vitest";
import { renderMonthlyReport } from "./render-monthly-report";
import type { MonthlyReportData } from "./monthly-report";

const BASE: MonthlyReportData = {
  monthKey: "2026-09",
  incomeAgorot: 1_672_783n,
  expenseAgorot: 1_250_000n,
  topCategories: [
    { name: "Groceries", spentAgorot: 600_000n },
    { name: "Dining", spentAgorot: 250_050n },
  ],
  netWorth: { startAgorot: 3_000_000n, endAgorot: 3_120_000n },
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
    expect(text).toContain("Open the dashboard: https://pfw.example/dashboard");
  });

  it("says what is missing instead of inventing a figure", () => {
    const { text } = renderMonthlyReport({ ...BASE, topCategories: [], netWorth: null }, "https://pfw.example/");
    expect(text).toContain("No spending recorded this month.");
    expect(text).toContain("Not enough history yet");
    expect(text).not.toContain("Start of month");
    expect(text).toContain("https://pfw.example/dashboard"); // a trailing slash on the origin is not doubled
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
      { ...BASE, topCategories: [{ name: '<img src=x onerror="alert(1)">', spentAgorot: 100n }] },
      "https://pfw.example",
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain('<a href="https://pfw.example/dashboard">');
  });

  it("shows a loss with a minus sign", () => {
    const { text } = renderMonthlyReport(
      { ...BASE, incomeAgorot: 0n, netWorth: { startAgorot: 500_000n, endAgorot: 400_000n } },
      "https://pfw.example",
    );
    expect(text).toContain("Net: -₪12,500.00");
    expect(text).toContain("Change: -₪1,000.00");
  });
});
