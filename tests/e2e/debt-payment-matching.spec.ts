import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { E2E_EMAIL } from "./global-setup";

/**
 * Payments found in your transactions on /debts, in a real browser against the
 * production build (AGENTS.md §3nnnn). Turns one of the e2e user's seeded
 * expenses into a repayment of the seeded mortgage (today's date, a name that
 * fits only that debt), records it, and puts the row, the mortgage balance and
 * its payments back in `afterAll`.
 */
test.describe.configure({ mode: "serial" });

test.describe("debt payment matching", () => {
  let db: Client;
  let userId = "";
  let tx: { id: string; occurredAt: Date; merchantName: string | null } | undefined;
  let mortgage: { id: string; currentBalance: string } | undefined;
  let paymentsBefore: string[] = [];

  test.beforeAll(async () => {
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    userId = (await db.query('SELECT id FROM "User" WHERE email = $1', [E2E_EMAIL])).rows[0].id;
    mortgage = (await db.query(`SELECT id, "currentBalance"::text AS "currentBalance" FROM "Debt" WHERE "userId" = $1 AND name ILIKE 'Mortgage%'`, [userId])).rows[0];
    if (!mortgage) throw new Error("Need the seeded mortgage for the e2e user — run `npm run db:seed` first.");
    paymentsBefore = (await db.query('SELECT id FROM "DebtPayment" WHERE "debtId" = $1', [mortgage.id])).rows.map((r) => r.id as string);
    tx = (
      await db.query(
        `SELECT id, "occurredAt", "merchantName" FROM "NotableTransaction"
         WHERE "userId" = $1 AND "deletedAt" IS NULL AND "isTransfer" = false AND amount < 0
           AND NOT EXISTS (SELECT 1 FROM "TransactionSplit" s WHERE s."transactionId" = "NotableTransaction".id)
         ORDER BY "occurredAt" ASC, id ASC LIMIT 1`,
        [userId],
      )
    ).rows[0];
    if (!tx) throw new Error("Need a seeded expense for the e2e user.");
    await db.query(`UPDATE "NotableTransaction" SET "occurredAt" = now(), "merchantName" = 'Mortgage payment' WHERE id = $1`, [tx.id]);
  });

  test.afterAll(async () => {
    if (tx && mortgage) {
      await db.query('DELETE FROM "DebtPayment" WHERE "debtId" = $1 AND id <> ALL($2::text[])', [mortgage.id, paymentsBefore]);
      await db.query('UPDATE "Debt" SET "currentBalance" = $2::bigint WHERE id = $1', [mortgage.id, mortgage.currentBalance]);
      await db.query('UPDATE "NotableTransaction" SET "occurredAt" = $2, "merchantName" = $3 WHERE id = $1', [tx.id, tx.occurredAt, tx.merchantName]);
    }
    await db.end();
  });

  test("lists the repayment, passes the accessibility scan, and records it against the mortgage", async ({ page }) => {
    const problems: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`console: ${message.text()}`);
    });
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));

    await page.goto("/debts");
    await page.getByRole("heading", { level: 1, name: "Debts" }).waitFor({ state: "visible" });
    await expect(page.getByRole("heading", { name: "Payments found in your transactions" })).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations, JSON.stringify(results.violations.map((v) => `${v.id}: ${v.help}`))).toEqual([]);

    const panel = page.locator("section", { has: page.getByRole("heading", { name: "Payments found in your transactions" }) });
    // Keep only our repayment ticked.
    const boxes = panel.getByRole("checkbox");
    for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).uncheck();
    await panel.getByRole("checkbox", { name: /Mortgage payment/ }).check();

    const applied = page.waitForResponse((r) => r.url().endsWith("/api/debts/payment-matches/apply") && r.request().method() === "POST");
    await panel.getByRole("button", { name: "Record 1 payment" }).click();
    expect((await applied).status()).toBe(200);
    await expect(page.getByText(/Recorded 1 payment\./)).toBeVisible();

    const linked = await db.query('SELECT 1 FROM "DebtPayment" WHERE "transactionId" = $1 AND "debtId" = $2', [tx!.id, mortgage!.id]);
    expect(linked.rowCount).toBe(1);
    const balance = (await db.query('SELECT "currentBalance"::bigint AS b FROM "Debt" WHERE id = $1', [mortgage!.id])).rows[0].b;
    // Moved by the payment's principal part. (A small payment against a big mortgage can be below the month's interest and raise it, which is the existing rule.)
    expect(String(balance)).not.toBe(mortgage!.currentBalance);
    expect(problems).toEqual([]);
  });

  test("does not offer the same repayment again", async ({ page }) => {
    await page.goto("/debts");
    await page.getByRole("heading", { level: 1, name: "Debts" }).waitFor({ state: "visible" });
    await expect(page.getByRole("checkbox", { name: /Mortgage payment/ })).toHaveCount(0);
  });
});
