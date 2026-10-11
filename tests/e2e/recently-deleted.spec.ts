import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { E2E_EMAIL } from "./global-setup";

/**
 * `/transactions/deleted` in a real browser against the production build.
 *
 * The seeded demo account has no deleted rows, so the accessibility audit
 * in `accessibility.spec.ts` would only ever see an empty page. This puts
 * two of its OLDEST transactions (the security spec works on the newest) in
 * the deleted state directly in Postgres, audits the populated page, and
 * clicks Restore for real. Everything is put back in `afterAll`.
 *
 * Serial because both tests mutate the same two rows.
 */
test.describe.configure({ mode: "serial" });

test.describe("/transactions/deleted", () => {
  let db: Client;
  let ids: string[] = [];

  async function markDeleted(batchId: string | null) {
    await db.query(
      'UPDATE "NotableTransaction" SET "deletedAt" = now(), "importBatchId" = $2 WHERE id = ANY($1::text[])',
      [ids, batchId],
    );
  }

  async function stillDeleted(): Promise<number> {
    const result = await db.query('SELECT count(*)::int AS n FROM "NotableTransaction" WHERE id = ANY($1::text[]) AND "deletedAt" IS NOT NULL', [ids]);
    return result.rows[0].n as number;
  }

  test.beforeAll(async () => {
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const result = await db.query(
      `SELECT t.id FROM "NotableTransaction" t JOIN "User" u ON u.id = t."userId"
       WHERE u.email = $1 AND t."deletedAt" IS NULL AND t."importBatchId" IS NULL
       ORDER BY t."occurredAt" ASC LIMIT 2`,
      [E2E_EMAIL],
    );
    ids = result.rows.map((row) => row.id as string);
    if (ids.length < 2) throw new Error("Need two seeded transactions for the e2e user — run `npm run db:seed` first.");
  });

  test.afterAll(async () => {
    await db.query('UPDATE "NotableTransaction" SET "deletedAt" = NULL, "importBatchId" = NULL WHERE id = ANY($1::text[])', [ids]);
    await db.end();
  });

  test("lists deleted rows with no axe violations or console errors, and restores one on click", async ({ page }) => {
    await markDeleted(null);

    const problems: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`console: ${message.text()}`);
    });
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));

    await page.goto("/transactions/deleted");
    await page.getByRole("heading", { level: 1, name: "Recently deleted" }).waitFor({ state: "visible" });
    await page.waitForLoadState("networkidle");

    const restoreButtons = page.getByRole("button", { name: "Restore", exact: true });
    await expect(restoreButtons).toHaveCount(2);
    // Two stray rows are not an import: no batch banner.
    await expect(page.getByText(/Statement import/)).toHaveCount(0);

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations, JSON.stringify(results.violations.map((v) => `${v.id}: ${v.help}`))).toEqual([]);

    // Wait for the request itself: while it is in flight the button's label
    // is "…", so counting "Restore" buttons would drop to one immediately.
    const restored = page.waitForResponse(
      (response) => response.url().includes("/delete") && response.request().method() === "POST",
    );
    await restoreButtons.first().click();
    expect((await restored).status()).toBe(200);
    await expect.poll(stillDeleted).toBe(1);
    await expect(restoreButtons).toHaveCount(1);

    expect(problems).toEqual([]);
  });

  test("restores a whole deleted import at once", async ({ page }) => {
    await markDeleted(`e2e-batch-${Date.now()}`);

    await page.goto("/transactions/deleted");
    await page.getByRole("heading", { level: 1, name: "Recently deleted" }).waitFor({ state: "visible" });

    await expect(page.getByText("Statement import · 2 rows deleted")).toBeVisible();
    await page.getByRole("button", { name: "Restore all 2" }).click();

    await expect(page.getByText("Nothing has been deleted.")).toBeVisible();
    expect(await stillDeleted()).toBe(0);
  });
});
