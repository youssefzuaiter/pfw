import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { E2E_EMAIL } from "./global-setup";

/**
 * /transactions/transfers in a real browser against the production build
 * (AGENTS.md §3kkkk). Turns two of the e2e user's seeded rows, in different
 * accounts, into the two halves of a transfer (same amount, a day apart),
 * checks the page, marks the pair and undoes it. Both rows are put back exactly
 * as they were in `afterAll`.
 *
 * Serial because the tests share the same two rows.
 */
test.describe.configure({ mode: "serial" });

const OUT_NAME = "E2E Transfer Out";
const IN_NAME = "E2E Transfer In";
const AMOUNT = 98_765_432n;

type Original = { id: string; amount: string; nativeAmount: string; occurredAt: Date; merchantName: string | null; isTransfer: boolean };

test.describe("transfer matching", () => {
  let db: Client;
  let original: Original[] = [];
  let outId = "";
  let inId = "";

  async function flags(): Promise<boolean[]> {
    const result = await db.query('SELECT "isTransfer" FROM "NotableTransaction" WHERE id = ANY($1::text[]) ORDER BY id', [[outId, inId]]);
    return result.rows.map((row) => row.isTransfer as boolean);
  }

  test.beforeAll(async () => {
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    // Two live, shekel, unsplit, unmarked rows in two different accounts.
    const picked = await db.query(
      `SELECT DISTINCT ON (t."bankAccountId") t.id, t.amount::text AS amount, t."nativeAmount"::text AS "nativeAmount",
              t."occurredAt", t."merchantName", t."isTransfer"
       FROM "NotableTransaction" t JOIN "User" u ON u.id = t."userId"
       WHERE u.email = $1 AND t."deletedAt" IS NULL AND t."isTransfer" = false AND t.currency = 'ILS'
         AND NOT EXISTS (SELECT 1 FROM "TransactionSplit" s WHERE s."transactionId" = t.id)
       ORDER BY t."bankAccountId", t.id LIMIT 2`,
      [E2E_EMAIL],
    );
    original = picked.rows;
    if (original.length < 2) throw new Error("Need rows in two accounts for the e2e user — run `npm run db:seed` first.");
    [outId, inId] = original.map((row) => row.id);
    await db.query(
      `UPDATE "NotableTransaction" SET amount = $2, "nativeAmount" = $2, "occurredAt" = '2001-05-05T12:00:00Z', "merchantName" = $3 WHERE id = $1`,
      [outId, (-AMOUNT).toString(), OUT_NAME],
    );
    await db.query(
      `UPDATE "NotableTransaction" SET amount = $2, "nativeAmount" = $2, "occurredAt" = '2001-05-06T12:00:00Z', "merchantName" = $3 WHERE id = $1`,
      [inId, AMOUNT.toString(), IN_NAME],
    );
  });

  test.afterAll(async () => {
    for (const row of original) {
      await db.query(
        'UPDATE "NotableTransaction" SET amount = $2, "nativeAmount" = $3, "occurredAt" = $4, "merchantName" = $5, "isTransfer" = $6 WHERE id = $1',
        [row.id, row.amount, row.nativeAmount, row.occurredAt, row.merchantName, row.isTransfer],
      );
    }
    await db.end();
  });

  test("lists the pair, passes the accessibility scan, marks it, and Undo takes it back", async ({ page }) => {
    const problems: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`console: ${message.text()}`);
    });
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));

    await page.goto("/transactions/transfers");
    await page.getByRole("heading", { level: 1, name: "Transfers between your accounts" }).waitFor({ state: "visible" });

    // Only our pair: other rows in the demo data may also look like transfers.
    await page.getByRole("button", { name: "Tick none" }).click();
    const box = page.getByRole("checkbox", { name: new RegExp(`Mark as a transfer: ${OUT_NAME}`) });
    await expect(box).toBeVisible();
    await expect(page.getByText(IN_NAME)).toBeVisible();
    await box.check();
    await expect(page.getByRole("button", { name: "Mark 1 pair as transfers" })).toBeEnabled();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations, JSON.stringify(results.violations.map((v) => `${v.id}: ${v.help}`))).toEqual([]);

    const applied = page.waitForResponse((r) => r.url().endsWith("/api/transactions/transfer-matches/apply") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Mark 1 pair as transfers" }).click();
    expect((await applied).status()).toBe(200);
    await expect(page.getByText("Marked 1 pair as transfers.")).toBeVisible();
    expect(await flags()).toEqual([true, true]);
    // The pair is no longer proposed.
    await expect(page.getByText(IN_NAME)).toHaveCount(0);

    const undone = page.waitForResponse((r) => r.url().endsWith("/api/transactions/bulk") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    expect((await undone).status()).toBe(200);
    await expect(page.getByText("Those transfers were unmarked.")).toBeVisible();
    expect(await flags()).toEqual([false, false]);
    expect(problems).toEqual([]);
  });

  test("is reachable from the transactions page", async ({ page }) => {
    await page.goto("/transactions");
    await page.getByRole("link", { name: "Transfers →" }).click();
    await expect(page).toHaveURL(/\/transactions\/transfers$/);
  });
});
