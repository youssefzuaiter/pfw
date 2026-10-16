import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import argon2 from "argon2";
import { Client } from "pg";

/**
 * First-run setup (AGENTS.md §3zzz), in a real browser against the production
 * build: a brand-new user is sent to the wizard, can move through it, and is
 * not sent back once it is finished or skipped. Each test has its own user and
 * starts signed out, never touching the suite's shared demo account.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const PASSWORD = "Onboarding-e2e-passw0rd!";

test.describe("first-run setup", () => {
  let db: Client;
  const created: string[] = [];

  async function newUser(label: string): Promise<string> {
    const email = `onboarding-e2e-${label}-${Date.now()}@pfw.local`;
    const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO "User" ("id", "email", "displayName", "passwordHash", "updatedAt")
       VALUES ('e2e_' || md5(random()::text), $1, 'Onboarding E2E', $2, now()) RETURNING "id"`,
      [email, passwordHash],
    );
    created.push(rows[0].id);
    return email;
  }

  async function signIn(page: import("@playwright/test").Page, email: string) {
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }

  test.beforeAll(async () => {
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
  });

  test.afterAll(async () => {
    // AuditLog is append-only, so a plain DELETE of a user that has audit rows is refused.
    // Deleting through the account-deletion path (which sets its purge flag) is the supported way.
    for (const id of created) {
      await db.query("BEGIN");
      try {
        await db.query("SELECT set_config('pfw.purge_user_id', $1, true)", [id]);
        await db.query('DELETE FROM "User" WHERE "id" = $1', [id]);
        await db.query('DELETE FROM "AccountDeletionRecord" WHERE "deletedUserId" = $1', [id]);
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }
    }
    await db.end();
  });

  test("sends a new user to setup, walks the three steps, and then goes straight to the dashboard", async ({ page }) => {
    await signIn(page, await newUser("walk"));
    await page.waitForURL("**/onboarding");
    await expect(page.getByRole("heading", { name: "Set up PFW" })).toBeVisible();

    const axeStep1 = await new AxeBuilder({ page }).analyze();
    expect(axeStep1.violations).toEqual([]);

    await page.getByLabel("Show totals in").selectOption("USD");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Add your first account" })).toBeVisible();

    await page.getByLabel("Institution").fill("Test Bank");
    await page.getByLabel("Last 4 digits").fill("4321");
    await page.getByLabel("Current balance").fill("1000");
    await page.getByRole("button", { name: "Add bank account" }).click();
    await expect(page.getByRole("heading", { name: "Bring in your transactions" })).toBeVisible();

    const axeStep3 = await new AxeBuilder({ page }).analyze();
    expect(axeStep3.violations).toEqual([]);

    // A real statement through the real importer: preview, then import.
    await page.locator('input[type="file"]').setInputFiles({
      name: "statement.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("Date,Description,Amount\n2026-10-01,Coffee,-12.50\n2026-10-02,Salary,5000.00\n"),
    });
    await page.getByRole("button", { name: /preview/i }).click();
    await expect(page.getByText("Coffee").first()).toBeVisible();
    await page.getByRole("button", { name: /^import/i }).click();
    await expect(page.getByText("2 transactions added.")).toBeVisible();

    await page.getByRole("button", { name: "Finish setup" }).click();
    await page.waitForURL("**/dashboard");

    // Finished: the dashboard no longer sends them back, and /onboarding itself bounces to it.
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.goto("/onboarding");
    await page.waitForURL("**/dashboard");
  });

  test("skipping goes to the dashboard and is remembered", async ({ page }) => {
    await signIn(page, await newUser("skip"));
    await page.waitForURL("**/onboarding");
    await page.getByRole("button", { name: "Skip setup" }).click();
    await page.waitForURL("**/dashboard");
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test("entering by hand lands on Transactions", async ({ page }) => {
    await signIn(page, await newUser("manual"));
    await page.waitForURL("**/onboarding");
    await page.getByLabel("Show totals in").selectOption("ILS");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "I'll add an account later" }).click();
    await page.getByRole("button", { name: "Enter transactions by hand instead" }).click();
    await page.waitForURL("**/transactions");
  });
});
