import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { Client } from "pg";

/**
 * Sign-up is closed unless `REGISTRATION_OPEN=true` (env.ts), checked here in
 * a real browser against the production build: the route refuses, no account
 * appears, the register page says so instead of offering a form, and the
 * login page stops linking to it.
 *
 * Runs signed OUT — signed in, the proxy sends /login and /register straight
 * to the dashboard. Skipped where an environment opens sign-up on purpose.
 */
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("sign-up is closed", () => {
  test.skip(process.env.REGISTRATION_OPEN === "true", "sign-up is open in this environment");

  test("the register page says so with no form, and the login page has no register link", async ({ page }) => {
    await page.goto("/register");
    await expect(page.getByRole("heading", { level: 1, name: "Sign-up is closed" })).toBeVisible();
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

    await page.goto("/login");
    await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Register" })).toHaveCount(0);
  });

  test("the route refuses a well-formed request from the site itself, and no account is created", async ({
    request,
    baseURL,
  }) => {
    const email = `closed-signup-${Date.now()}@example.com`;
    const response = await request.post("/api/auth/register", {
      headers: { origin: baseURL ?? "" },
      data: { email, password: "a-long-enough-password", displayName: "Should Not Exist" },
    });

    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual({ error: "Registration is closed." });

    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    try {
      const result = await db.query('SELECT count(*)::int AS n FROM "User" WHERE email = $1', [email]);
      expect(result.rows[0].n).toBe(0);
    } finally {
      await db.end();
    }
  });
});
