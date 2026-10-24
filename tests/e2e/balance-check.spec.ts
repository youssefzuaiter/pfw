import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * "Check against bank" on /assets, in a real browser against the production
 * build (AGENTS.md §3oooo). Checking changes nothing, so it needs no cleanup:
 * type a figure that cannot match, read the difference and the likely reasons,
 * scan the open form for accessibility problems, and try a future day.
 */
test.describe("balance check", () => {
  test("shows the difference and the likely reasons, and passes the accessibility scan", async ({ page }) => {
    const problems: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`console: ${message.text()}`);
    });
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));

    await page.goto("/assets");
    await page.getByRole("heading", { level: 1, name: "Assets" }).waitFor({ state: "visible" });

    await page.getByRole("button", { name: "Check against bank" }).first().click();
    await page.getByLabel(/shows$/).first().fill("0.01");
    await page.getByRole("button", { name: "Check", exact: true }).click();

    await expect(page.getByText(/PFW works out/)).toBeVisible();
    await expect(page.getByText(/^Difference /)).toBeVisible();
    await expect(page.getByText("Likely reasons, most likely first:")).toBeVisible();
    await expect(page.getByRole("button", { name: /Use the bank/ })).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations, JSON.stringify(results.violations.map((v) => `${v.id}: ${v.help}`))).toEqual([]);
    expect(problems).toEqual([]);
  });

  test("refuses a day that has not happened", async ({ page }) => {
    await page.goto("/assets");
    await page.getByRole("button", { name: "Check against bank" }).first().click();
    await page.getByLabel(/shows$/).first().fill("10");
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    await page.getByLabel("For the day").first().fill(future);
    await page.getByRole("button", { name: "Check", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "has not happened yet" })).toBeVisible();
  });
});
