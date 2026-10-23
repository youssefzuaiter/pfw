import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";
import { E2E_EMAIL } from "./global-setup";

/**
 * Bulk edit on /transactions in a real browser against the production build
 * (AGENTS.md §3hhhh): tick several rows, set a category, mark them as
 * transfers, delete them and undo it. Works on the e2e user's three OLDEST
 * seeded transactions and puts every field back in `afterAll`.
 *
 * Serial because every test edits the same three rows.
 */
test.describe.configure({ mode: "serial" });

test.describe("bulk edit", () => {
  let db: Client;
  let ids: string[] = [];
  let original: { id: string; categoryId: string; isTransfer: boolean; needsReview: boolean }[] = [];
  let targetCategory: { id: string; name: string };

  async function rowsNow() {
    const result = await db.query(
      'SELECT id, "categoryId", "isTransfer", "needsReview", "deletedAt" FROM "NotableTransaction" WHERE id = ANY($1::text[])',
      [ids],
    );
    return result.rows as { id: string; categoryId: string; isTransfer: boolean; needsReview: boolean; deletedAt: Date | null }[];
  }

  async function openAndTick(page: Page) {
    await page.goto("/transactions?sort=date_asc");
    await page.getByRole("heading", { level: 1, name: "Transactions" }).waitFor({ state: "visible" });
    for (const id of ids) {
      const checkbox = page.locator(`tr[data-transaction-id="${id}"] input[type="checkbox"]`);
      await expect(checkbox).toBeVisible();
      await checkbox.check();
    }
    await expect(page.getByText("3 selected")).toBeVisible();
  }

  async function waitForBulk(page: Page, click: () => Promise<void>) {
    const response = page.waitForResponse((r) => r.url().endsWith("/api/transactions/bulk") && r.request().method() === "POST");
    await click();
    expect((await response).status()).toBe(200);
  }

  test.beforeAll(async () => {
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const picked = await db.query(
      `SELECT t.id, t."categoryId", t."isTransfer", t."needsReview" FROM "NotableTransaction" t JOIN "User" u ON u.id = t."userId"
       WHERE u.email = $1 AND t."deletedAt" IS NULL AND t."importBatchId" IS NULL
         AND NOT EXISTS (SELECT 1 FROM "TransactionSplit" s WHERE s."transactionId" = t.id)
       ORDER BY t."occurredAt" ASC, t.id ASC LIMIT 3`,
      [E2E_EMAIL],
    );
    original = picked.rows;
    ids = original.map((row) => row.id);
    if (ids.length < 3) throw new Error("Need three seeded transactions for the e2e user — run `npm run db:seed` first.");
    const category = await db.query(
      `SELECT c.id, c.name FROM "Category" c JOIN "User" u ON u.id = c."userId"
       WHERE u.email = $1 AND c."isUncategorized" = false AND c."archivedAt" IS NULL AND c.id <> ALL($2::text[])
       ORDER BY c.name ASC LIMIT 1`,
      [E2E_EMAIL, original.map((row) => row.categoryId)],
    );
    if (category.rows.length === 0) throw new Error("Need a category none of the three rows is in.");
    targetCategory = category.rows[0];
  });

  test.afterAll(async () => {
    for (const row of original) {
      await db.query('UPDATE "NotableTransaction" SET "categoryId" = $2, "isTransfer" = $3, "needsReview" = $4, "deletedAt" = NULL WHERE id = $1', [
        row.id,
        row.categoryId,
        row.isTransfer,
        row.needsReview,
      ]);
    }
    await db.end();
  });

  test("the bar passes the accessibility scan, and a category is set on all three rows", async ({ page }) => {
    const problems: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`console: ${message.text()}`);
    });
    await openAndTick(page);

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations, JSON.stringify(results.violations.map((v) => `${v.id}: ${v.help}`))).toEqual([]);

    await page.getByLabel("Category for the selected transactions").selectOption({ label: targetCategory.name });
    await waitForBulk(page, () => page.getByRole("button", { name: "Set category" }).click());
    await expect(page.getByText("Changed the category of 3 transactions.")).toBeVisible();
    await expect(page.getByText("3 selected")).toHaveCount(0);

    const rows = await rowsNow();
    expect(rows.map((row) => row.categoryId)).toEqual([targetCategory.id, targetCategory.id, targetCategory.id]);
    expect(rows.every((row) => row.needsReview === false)).toBe(true);
    expect(problems).toEqual([]);
  });

  test("they can be marked as transfers and unmarked", async ({ page }) => {
    await openAndTick(page);
    await waitForBulk(page, () => page.getByRole("button", { name: "Mark as transfer" }).click());
    await expect.poll(async () => (await rowsNow()).every((row) => row.isTransfer)).toBe(true);

    await openAndTick(page);
    await waitForBulk(page, () => page.getByRole("button", { name: "Not a transfer" }).click());
    await expect.poll(async () => (await rowsNow()).every((row) => !row.isTransfer)).toBe(true);
  });

  test("delete asks first, deletes all three, and Undo brings the same three back", async ({ page }) => {
    await openAndTick(page);
    // Every row has its own Delete too: this is the one in the bar.
    await page.getByRole("region", { name: "Actions for the selected transactions" }).getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByText("Delete 3 transactions?")).toBeVisible();
    // Nothing is deleted until it is confirmed.
    expect((await rowsNow()).every((row) => row.deletedAt === null)).toBe(true);

    await waitForBulk(page, () => page.getByRole("button", { name: "Yes, delete" }).click());
    await expect.poll(async () => (await rowsNow()).every((row) => row.deletedAt !== null)).toBe(true);
    await expect(page.getByText("Deleted 3 transactions.")).toBeVisible();

    await waitForBulk(page, () => page.getByRole("button", { name: "Undo" }).click());
    await expect.poll(async () => (await rowsNow()).every((row) => row.deletedAt === null)).toBe(true);
    await expect(page.getByText("Restored 3 transactions.")).toBeVisible();
  });
});
