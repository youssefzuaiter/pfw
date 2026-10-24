import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { E2E_EMAIL } from "./global-setup";

/**
 * Suggested budgets on /budgets in a real browser against the production build
 * (AGENTS.md §3mmmm). The seeded demo account has spending in the previous
 * months and some open envelopes this month, so the panel is there. Sets one
 * envelope to ₪10 and removes every allocation it created in `afterAll`.
 *
 * Serial because both tests share the same page state.
 */
test.describe.configure({ mode: "serial" });

test.describe("suggested budgets", () => {
  let db: Client;
  let userId = "";
  let before: string[] = [];
  const month = new Date().toISOString().slice(0, 7);

  test.beforeAll(async () => {
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    userId = (await db.query('SELECT id FROM "User" WHERE email = $1', [E2E_EMAIL])).rows[0].id;
    before = (await db.query('SELECT id FROM "EnvelopeAllocation" WHERE "userId" = $1 AND month = $2', [userId, month])).rows.map((r) => r.id as string);
  });

  test.afterAll(async () => {
    await db.query('DELETE FROM "EnvelopeAllocation" WHERE "userId" = $1 AND month = $2 AND id <> ALL($3::text[])', [userId, month, before]);
    await db.end();
  });

  test("lists the suggestions, passes the accessibility scan, and sets the chosen envelope", async ({ page }) => {
    const problems: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`console: ${message.text()}`);
    });
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));

    await page.goto("/budgets");
    await page.getByRole("heading", { level: 1, name: "Budgets" }).waitFor({ state: "visible" });
    await expect(page.getByRole("heading", { name: "Suggested budgets" })).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations, JSON.stringify(results.violations.map((v) => `${v.id}: ${v.help}`))).toEqual([]);

    // Keep only the first suggestion, at ₪10.
    const panel = page.locator("section", { has: page.getByRole("heading", { name: "Suggested budgets" }) });
    const boxes = panel.getByRole("checkbox");
    const count = await boxes.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 1; i < count; i++) await boxes.nth(i).uncheck();
    await panel.locator('input[inputmode="decimal"]').first().fill("10.00");
    await expect(panel.getByText("₪10.00").first()).toBeVisible();

    const applied = page.waitForResponse((r) => r.url().endsWith("/api/envelopes/suggestions/apply") && r.request().method() === "POST");
    await panel.getByRole("button", { name: "Set 1 envelope" }).click();
    expect((await applied).status()).toBe(200);
    await expect(page.getByText(/Set 1 envelope for/)).toBeVisible();

    const created = await db.query('SELECT "amountAgorot"::text AS amount FROM "EnvelopeAllocation" WHERE "userId" = $1 AND month = $2 AND id <> ALL($3::text[])', [userId, month, before]);
    expect(created.rows.map((r) => r.amount)).toEqual(["1000"]);
    expect(problems).toEqual([]);
  });

  test("turns Apply off when an amount is more than is available", async ({ page }) => {
    await page.goto("/budgets");
    const panel = page.locator("section", { has: page.getByRole("heading", { name: "Suggested budgets" }) });
    await expect(panel).toBeVisible();
    await panel.locator('input[inputmode="decimal"]').first().fill("999999999");
    await expect(panel.getByRole("alert")).toContainText("Untick some or lower an amount");
    await expect(panel.getByRole("button", { name: /^Set \d+ envelopes?$/ })).toBeDisabled();
  });
});
