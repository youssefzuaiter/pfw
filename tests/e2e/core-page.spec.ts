import { expect, test } from "@playwright/test";

/**
 * `/trading/core` (AGENTS.md §3fff) in a real browser against the production
 * build — the one place its CSP behaviour can be seen. axe (in
 * `accessibility.spec.ts`) checks contrast and structure but not the browser
 * console, and a blocked inline style is silent there: the Recharts charts
 * were invisible for months under this app's CSP before anyone looked (§3x).
 * This page uses no charts and no inline styles, and this keeps it that way.
 *
 * Runs as the seeded demo account, whose seed gives it the populated mirror.
 */
test.describe("/trading/core", () => {
  test("renders the demo account's mirror with no console errors, page errors or CSP violations", async ({ page }) => {
    const problems: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`console: ${message.text()}`);
    });
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));

    await page.goto("/trading/core");
    await page.getByRole("heading", { level: 1, name: "Long-term core" }).waitFor({ state: "visible" });
    await page.waitForLoadState("networkidle");

    // The page re-verifies the stored hash chain on every load, from the stored lines.
    await expect(page.getByText(/Verified · \d+ entries, hash chain intact/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Plan history" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Journal entries, newest first" })).toBeVisible();

    expect(problems).toEqual([]);
  });

  test("is read-only: nothing on it can approve, halt or trade", async ({ page }) => {
    await page.goto("/trading/core");
    await page.getByRole("heading", { level: 1, name: "Long-term core" }).waitFor({ state: "visible" });
    const names = await page.getByRole("button").evaluateAll((buttons) => buttons.map((b) => (b.textContent ?? "").trim()));
    for (const name of names) {
      expect(name).not.toMatch(/approve|halt|trade|sell|buy|fund|raise/i);
    }
  });

  test("the app-wide currency toggle switches which figure leads, on this page too", async ({ page }) => {
    await page.goto("/trading/core");
    await page.getByRole("heading", { name: "Holdings against target" }).waitFor({ state: "visible" });

    const toggle = page.getByRole("button", { name: /Showing:/ });
    await expect(toggle).toContainText("₪ (ILS)");
    const firstFigure = page.locator("table tbody tr").first().locator("p").first();
    await expect(firstFigure).toContainText("₪");

    await toggle.click();
    await expect(toggle).toContainText("Native currency");
    await expect(firstFigure).toContainText("$");

    await toggle.click(); // leave the preference as it was found
    await expect(toggle).toContainText("₪ (ILS)");
  });
});
