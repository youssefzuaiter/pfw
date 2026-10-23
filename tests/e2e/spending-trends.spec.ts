import { expect, test } from "@playwright/test";

/**
 * /trends on the production build as the demo account (AGENTS.md §3iiii): the
 * seeded ledger has a few months of spending, so the page shows a comparison,
 * the month bars and a category table, and it is reachable from the review page.
 */
test("spending trends shows the comparison, the months and the categories", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });

  await page.goto("/review");
  await page.getByRole("link", { name: "Spending trends" }).click();
  await expect(page).toHaveURL(/\/trends$/);
  await expect(page.getByRole("heading", { level: 1, name: "Spending trends" })).toBeVisible();

  await expect(page.getByRole("heading", { name: "This month so far" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Spending by month" })).toBeVisible();
  // Six months of bars, the last one marked as still in progress.
  await expect(page.getByRole("progressbar")).toHaveCount(6);
  await expect(page.getByRole("progressbar").last()).toHaveAttribute("aria-label", /\(so far\)/);

  const table = page.getByRole("table");
  await expect(table.getByRole("columnheader", { name: "Usual by now" })).toBeVisible();
  expect(await table.getByRole("row").count()).toBeGreaterThan(1);
  expect(problems).toEqual([]);
});
