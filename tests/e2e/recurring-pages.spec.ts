import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { STORAGE_STATE_PATH } from "./global-setup";

/**
 * The Subscriptions and Bills pages are independent (AGENTS.md §3eeee): each
 * has its own add form and its own list, and what is added on one never shows
 * on the other. Runs against the production build as the demo account; every
 * item it adds is deleted again, even when an assertion fails.
 */
test.describe.configure({ mode: "serial" });

const SUBSCRIPTION = "E2E Zebracloud Test";
const BILL = "E2E Electricity Test";
const VARYING_BILL = "E2E Varying Test";

async function add(page: import("@playwright/test").Page, name: string, addButton: string, saveButton: string) {
  // The form is behind the page's Add button.
  await expect(page.getByRole("button", { name: addButton, exact: true })).toBeVisible();
  await page.getByRole("button", { name: addButton, exact: true }).click();
  await page.getByLabel("Name", { exact: true }).first().fill(name);
  await page.getByLabel("Amount", { exact: true }).first().fill("12.50");
  await page.getByRole("button", { name: saveButton, exact: true }).click();
  await expect(page.getByText(name).first()).toBeVisible();
  // What was added can be deleted from the list right there.
  await expect(page.locator("li", { hasText: name }).getByRole("button", { name: "Delete", exact: true })).toBeVisible();
}

async function removeIfPresent(page: import("@playwright/test").Page, url: string, name: string) {
  await page.goto(url);
  // The page streams in behind a loading skeleton: wait for the real content before counting rows.
  await expect(page.getByRole("button", { name: /^\+ Add / })).toBeVisible();
  // Delete every row with this name (a failed earlier run may have left one more than expected).
  for (let attempt = 0; attempt < 5; attempt++) {
    // Only the rows that can be deleted: "Coming up" lists the same name without buttons.
    const rows = page.locator("li", { hasText: name, has: page.getByRole("button", { name: "Delete", exact: true }) });
    const before = await rows.count();
    if (before === 0) return;
    await rows.first().getByRole("button", { name: "Delete", exact: true }).click();
    // The row stops matching once it asks to confirm, and only one confirm is ever open.
    await page.getByRole("button", { name: "Yes, delete" }).click();
    await expect(rows).toHaveCount(before - 1);
  }
}

// A context made by hand does not inherit the project's baseURL, so it is passed on.
test.afterAll(async ({ browser, baseURL }) => {
  const context = await browser.newContext({ storageState: STORAGE_STATE_PATH, baseURL });
  const page = await context.newPage();
  await removeIfPresent(page, "/transactions/subscriptions", SUBSCRIPTION);
  await removeIfPresent(page, "/transactions/bills", BILL);
  await removeIfPresent(page, "/transactions/bills", VARYING_BILL);
  await context.close();
});

test("a subscription is added on the Subscriptions page and stays off the Bills page", async ({ page }) => {
  await page.goto("/transactions/subscriptions");
  await expect(page.getByRole("heading", { name: /^Spent on subscriptions in / })).toBeVisible();
  await add(page, SUBSCRIPTION, "+ Add subscription", "Save subscription");

  await page.goto("/transactions/bills");
  await expect(page.getByRole("heading", { name: /^Spent on bills in / })).toBeVisible();
  await expect(page.getByRole("button", { name: "+ Add bill", exact: true })).toBeVisible();
  await expect(page.getByText(SUBSCRIPTION)).toHaveCount(0);
});

test("a bill is added on the Bills page and stays off the Subscriptions page", async ({ page }) => {
  await page.goto("/transactions/bills");
  await add(page, BILL, "+ Add bill", "Save bill");

  await page.goto("/transactions/subscriptions");
  await expect(page.getByText(BILL)).toHaveCount(0);
  await expect(page.getByText(SUBSCRIPTION).first()).toBeVisible();
});

test("each page has its own calendar: the new item is on today's date, and the month can be changed", async ({ page }) => {
  await page.goto("/transactions/subscriptions");
  const subscriptionsCalendar = page.locator("section", { has: page.getByRole("heading", { name: /^Calendar · / }) });
  await expect(subscriptionsCalendar.getByText(SUBSCRIPTION).first()).toBeVisible();
  await expect(subscriptionsCalendar.getByText(BILL)).toHaveCount(0);

  const heading = page.getByRole("heading", { name: /^Calendar · / });
  const before = await heading.textContent();
  await page.getByRole("link", { name: "Next →" }).click();
  await expect(page).toHaveURL(/month=\d{4}-\d{2}/);
  await expect(heading).not.toHaveText(before ?? "");
  // Next month the monthly subscription is expected again, still on its own page.
  await expect(page.locator("section", { has: heading }).getByText(SUBSCRIPTION).first()).toBeVisible();
  await page.getByRole("link", { name: "This month" }).click();
  await expect(heading).toHaveText(before ?? "");

  await page.goto("/transactions/bills");
  const billsCalendar = page.locator("section", { has: page.getByRole("heading", { name: /^Calendar · / }) });
  await expect(billsCalendar.getByText(BILL).first()).toBeVisible();
  await expect(billsCalendar.getByText(SUBSCRIPTION)).toHaveCount(0);
});

test("both pages with an item on them pass the accessibility scan", async ({ page }) => {
  for (const url of ["/transactions/subscriptions", "/transactions/bills"]) {
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(results.violations, url).toEqual([]);
  }
});

test("a bill whose amount varies asks for a typical amount, says how it is worked out, and passes the accessibility scan", async ({ page }) => {
  await page.goto("/transactions/bills");
  await page.getByRole("button", { name: "+ Add bill", exact: true }).click();
  await page.getByLabel("The amount is different every time").check();
  await expect(page.getByLabel("Amount", { exact: true })).toHaveCount(0);
  await page.getByLabel("Name", { exact: true }).first().fill(VARYING_BILL);
  await page.getByLabel("Typical amount", { exact: true }).fill("300");

  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(results.violations).toEqual([]);

  await page.getByRole("button", { name: "Save bill", exact: true }).click();
  const row = page.locator("li", { hasText: VARYING_BILL, has: page.getByRole("button", { name: "Delete", exact: true }) });
  await expect(row).toBeVisible();
  // No payments yet, so it is the typed amount that is used, and the row says so.
  await expect(row.getByText(/Different every time/)).toBeVisible();
  await expect(row.getByText(/about/i).first()).toBeVisible();
});
