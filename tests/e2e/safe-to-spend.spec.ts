import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * The dashboard's Safe to Spend card (formula: `src/lib/safe-to-spend.ts`)
 * in a real browser against the production build. `accessibility.spec.ts`
 * audits the dashboard with the breakdown collapsed, and axe cannot see
 * inside a closed `<details>`, so this opens it and scans the open card; it
 * also checks that the page and `GET /api/analytics/safe-to-spend` report
 * the same figure and that the breakdown adds up on screen.
 *
 * Runs as the seeded demo account.
 */
test.describe("Safe to Spend", () => {
  test("shows the figure, and its open breakdown passes an accessibility scan", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto("/dashboard");
    const card = page.getByRole("region", { name: "Safe to spend" });
    await expect(card).toBeVisible();
    await expect(card.getByTestId("safe-to-spend-value")).toHaveText(/[₪$€£₺]/);

    await card.getByText("How this is calculated").click();
    await expect(card.getByText("Cash in checking and savings")).toBeVisible();

    const axe = await new AxeBuilder({ page }).include('section[aria-labelledby="safe-to-spend-heading"]').analyze();
    expect(axe.violations).toEqual([]);

    // The dashboard's Recharts charts log CSP warnings for their own inline styles (AGENTS.md §3x),
    // so a console check here would blame this card for them. What this card must never do is
    // carry an inline style itself: this app's CSP blocks those silently.
    await expect(card.locator("[style]")).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test("the endpoint reports the same figure the page shows, and its parts add up", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByTestId("safe-to-spend-value")).toBeVisible();
    const shown = (await page.getByTestId("safe-to-spend-value").innerText()).trim();

    const response = await page.request.get("/api/analytics/safe-to-spend");
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toContain("no-store");
    const body = await response.json();

    // The formula, on the wire.
    expect(body.safeToSpendAgorot).toBe(
      body.cashAgorot -
        body.cardOwedAgorot -
        body.envelopeReserveAgorot -
        body.billsNotCoveredAgorot -
        body.debtDueAgorot -
        body.goalDueAgorot,
    );
    expect(body.isOverCommitted).toBe(body.safeToSpendAgorot < 0);
    // Income still to arrive is reported beside the figure, never inside it.
    expect(body.safeToSpendWithExpectedIncomeAgorot).toBe(body.safeToSpendAgorot + body.expectedIncomeAgorot);

    // The page prints that same number in the shekel format of the demo account's reporting currency.
    const digits = Math.abs(body.safeToSpendAgorot / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    expect(shown).toContain(digits);
  });

});

test.describe("Safe to Spend, signed out", () => {
  // The config signs every test in as the demo account; this one must not be.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the endpoint refuses a signed-out caller", async ({ request }) => {
    const response = await request.get("/api/analytics/safe-to-spend");
    expect(response.status()).toBe(401);
  });
});
