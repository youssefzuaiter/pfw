import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import argon2 from "argon2";
import { Client } from "pg";

/**
 * Account deletion through the real UI, against the production build
 * (AGENTS.md §3ttt): a throwaway user signs in, opens Settings → Delete
 * account, is refused with a wrong password, deletes with the right one, and
 * lands on the login page told so, while the database holds no User row for
 * them and one deletion record. The open form is also scanned for
 * accessibility, which the settings page's own scan (form closed) does not
 * cover.
 *
 * Its own user, never the suite's shared demo account. Starts signed out.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const PASSWORD = "deletion-e2e-password-not-a-real-secret";

test.describe("account deletion", () => {
  let db: Client;
  let userId = "";
  const email = `deletion-e2e-${Date.now()}@pfw.local`;

  test.beforeAll(async () => {
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO "User" ("id", "email", "displayName", "passwordHash", "updatedAt")
       VALUES ('e2e_' || md5(random()::text), $1, 'Deletion E2E', $2, now()) RETURNING "id"`,
      [email, passwordHash],
    );
    userId = rows[0].id;
    await db.query(
      `INSERT INTO "Notification" ("id", "userId", "type", "message") VALUES ('e2e_' || md5(random()::text), $1, 'test', 'hello')`,
      [userId],
    );
  });

  test.afterAll(async () => {
    // Only reached with rows left if the test failed before deleting.
    await db.query('DELETE FROM "Notification" WHERE "userId" = $1', [userId]);
    await db.query('DELETE FROM "User" WHERE "id" = $1', [userId]);
    await db.query('DELETE FROM "AccountDeletionRecord" WHERE "deletedUserId" = $1', [userId]);
    await db.end();
  });

  test("refuses a wrong password, then deletes everything and signs out", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL("**/dashboard");

    await page.goto("/settings");
    await page.getByRole("button", { name: "Delete account…" }).click();
    await expect(page.getByRole("heading", { name: "Delete your account permanently" })).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

    const submit = page.getByRole("button", { name: "Delete my account" });
    await page.getByLabel("Current password").fill("not-the-password");
    await page.getByLabel("Type DELETE to confirm").fill("DELETE");
    await submit.click();
    // Not getByRole("alert") alone: Next.js has its own (empty) route-announcer alert on every page.
    await expect(page.getByRole("alert").filter({ hasText: "Incorrect password" })).toBeVisible();
    expect((await db.query('SELECT 1 FROM "User" WHERE "id" = $1', [userId])).rowCount).toBe(1);

    await page.getByLabel("Current password").fill(PASSWORD);
    await submit.click();
    await page.waitForURL("**/login?deleted=1");
    await expect(page.getByRole("status").filter({ hasText: "Your account and its data were deleted." })).toBeVisible();

    expect((await db.query('SELECT 1 FROM "User" WHERE "id" = $1', [userId])).rowCount).toBe(0);
    expect((await db.query('SELECT 1 FROM "Notification" WHERE "userId" = $1', [userId])).rowCount).toBe(0);
    expect((await db.query('SELECT 1 FROM "AccountDeletionRecord" WHERE "deletedUserId" = $1', [userId])).rowCount).toBe(1);

    // The session went with it: a protected page sends this browser to sign in.
    await page.goto("/dashboard");
    await page.waitForURL("**/login**");
  });
});
