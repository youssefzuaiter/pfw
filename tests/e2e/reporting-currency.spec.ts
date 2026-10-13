import { expect, test } from "@playwright/test";

/**
 * The reporting currency (AGENTS.md §3nnn) end to end on the production
 * build: the root layout resolves the setting and hands it to every client
 * component, which no unit test exercises. The demo account is switched to
 * dollars for this one test and always switched back, so the specs that run
 * after it see shekels.
 */
test.describe("reporting currency", () => {
  test("shows dashboard totals in dollars with the rate stated, and leaves the trading desk in shekels", async ({ page }) => {
    const toDollars = await page.request.patch("/api/user-settings", { data: { reportingCurrency: "USD" } });
    expect(toDollars.status()).toBe(200);

    try {
      await page.goto("/dashboard");
      await page.getByRole("heading", { level: 1, name: "Dashboard" }).waitFor({ state: "visible" });

      await expect(page.getByText(/^Totals shown in US dollars at ₪\d+\.\d{4} per \$1/)).toBeVisible();
      const netWorth = page.locator('[aria-labelledby="net-worth-heading"]');
      await expect(netWorth).toContainText(/-?\$[\d,]+\.\d\d/);
      await expect(netWorth).not.toContainText("₪");

      await page.goto("/trading");
      await page.getByRole("heading", { level: 1 }).first().waitFor({ state: "visible" });
      await expect(page.getByText(/^Totals shown in/)).toHaveCount(0);
      await expect(page.locator("main")).toContainText(/₪[\d,]+\.\d\d/);
    } finally {
      const back = await page.request.patch("/api/user-settings", { data: { reportingCurrency: "ILS" } });
      expect(back.status()).toBe(200);
    }

    await page.goto("/dashboard");
    await page.getByRole("heading", { level: 1, name: "Dashboard" }).waitFor({ state: "visible" });
    await expect(page.getByText(/^Totals shown in/)).toHaveCount(0);
    await expect(page.locator('[aria-labelledby="net-worth-heading"]')).toContainText(/₪[\d,]+\.\d\d/);
  });
});
