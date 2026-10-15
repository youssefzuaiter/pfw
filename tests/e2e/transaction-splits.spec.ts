import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { E2E_EMAIL } from "./global-setup";

/**
 * Splitting a transaction (AGENTS.md §3xxx) in a real browser against the
 * production build: the editor passes an accessibility scan, Save stays off
 * one agorah short, a saved split shows on the row without a reload and in
 * the ledger, and removing it puts the row back. Works on the seeded demo
 * account's newest expense and leaves it unsplit.
 */
test.describe("splitting a transaction", () => {
  let db: Client;
  let transaction: { id: string; amount: number; categoryName: string };

  test.beforeAll(async () => {
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const result = await db.query(
      `SELECT t.id, t.amount::int AS amount, c.name AS "categoryName"
         FROM "NotableTransaction" t
         JOIN "User" u ON u.id = t."userId"
         JOIN "Category" c ON c.id = t."categoryId"
        WHERE u.email = $1 AND t."deletedAt" IS NULL AND t."isTransfer" = false AND t.amount < -200 AND t.currency = 'ILS'
          AND NOT c."isUncategorized"
        ORDER BY t."occurredAt" DESC LIMIT 1`,
      [E2E_EMAIL],
    );
    transaction = result.rows[0];
    expect(transaction, "the seeded demo account has a shekel expense to split").toBeTruthy();
  });

  test.afterAll(async () => {
    await db.query('DELETE FROM "TransactionSplit" WHERE "transactionId" = $1', [transaction.id]);
    await db.end();
  });

  test("split, check, and remove", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    await page.goto("/transactions");
    const row = page.locator(`tr[data-transaction-id="${transaction.id}"]`);
    await row.getByRole("button", { name: "Split", exact: true }).click();

    const dialog = page.getByRole("dialog", { name: "Split across categories" });
    await expect(dialog).toBeVisible();
    const axe = await new AxeBuilder({ page }).include('[role="dialog"][aria-labelledby^="split-title"]').analyze();
    expect(axe.violations).toEqual([]);

    const total = Math.abs(transaction.amount);
    const first = total - 100;
    const toText = (minor: number) => `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
    await dialog.getByLabel("Amount 1 (₪)").fill(toText(first));
    const secondCategory = await dialog.getByLabel("Category 2").locator("option").nth(1).getAttribute("value");
    const firstCategory = await dialog.getByLabel("Category 1").inputValue();
    const otherCategory =
      secondCategory === firstCategory ? await dialog.getByLabel("Category 2").locator("option").nth(2).getAttribute("value") : secondCategory;
    await dialog.getByLabel("Category 2").selectOption(otherCategory!);
    await dialog.getByLabel("Amount 2 (₪)").fill("0.99");
    await expect(dialog.getByText("₪0.01 left to assign.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Save split" })).toBeDisabled();

    await dialog.getByLabel("Amount 2 (₪)").fill("1.00");
    await expect(dialog.getByText("Adds up exactly.")).toBeVisible();
    await dialog.getByRole("button", { name: "Save split" }).click();
    await expect(dialog).toBeHidden();
    await expect(row.getByText(/^Split: /)).toBeVisible();

    const stored = await db.query('SELECT sum(amount)::int AS sum, count(*)::int AS n FROM "TransactionSplit" WHERE "transactionId" = $1', [
      transaction.id,
    ]);
    expect(stored.rows[0]).toEqual({ sum: transaction.amount, n: 2 });
    const ledger = await page.request.get(`/api/transactions/${transaction.id}/ledger`);
    expect((await ledger.json()).chainValid).toBe(true);

    await row.getByRole("button", { name: "Edit split" }).click();
    await dialog.getByRole("button", { name: "Remove split" }).click();
    await expect(dialog).toBeHidden();
    await expect(row.getByRole("button", { name: "Split", exact: true })).toBeVisible();
    expect(consoleErrors).toEqual([]);
  });
});
