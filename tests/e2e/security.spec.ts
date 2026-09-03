import { Client } from "pg";
import { expect, test } from "@playwright/test";
import { E2E_EMAIL } from "./global-setup";

/**
 * Phase 7's security hardening pass, automated against the real running
 * app (spec item 3: IDOR/404, CSRF rejection, SQLi fuzzing, XSS
 * injection, rate-limit enforcement). CSV formula neutralization is
 * deliberately NOT covered here — there is no CSV import feature in this
 * codebase yet (AGENTS.md §5, decision #4: deferred, not built), so
 * there is nothing to exercise; fabricating a test against a
 * nonexistent endpoint would be worse than omitting it.
 *
 * Seed data (a real transaction id, category id, and a temporary XSS
 * payload) is read/written directly over `pg` rather than through the
 * app's Prisma client — the admin Prisma client is guarded by
 * `import "server-only"`, which requires the `react-server` export
 * condition Next sets when bundling (see AGENTS.md's deviations list);
 * Playwright's plain Node test runner doesn't set it, and `merchantName`
 * is plaintext at the DB level (unlike `description`), so raw SQL is a
 * legitimate, simple way to reach it here.
 */

let db: Client;
let realTransactionId: string;
let realCategoryId: string;
let otherCategoryId: string;

test.beforeAll(async () => {
  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  // Scoped to the e2e test user's OWN data (§3kk) — a real bug this fix
  // closes: real multi-user auth (§3ff) means this dev database can now
  // hold several users' transactions, and the un-scoped "most recent
  // transaction across the whole table" query this file originally used
  // could grab a row belonging to a DIFFERENT user than the one
  // `global-setup.ts` actually signs the browser in as. The requests
  // below are made under that authenticated session (via `storageState`),
  // so RLS correctly 404s a cross-user PATCH — which is the right
  // behavior, but meant these tests were failing on a false premise
  // (asserting 200 against a row the session doesn't own), not
  // discovering a real IDOR gap.
  const rows = await db.query<{ id: string; categoryId: string }>(
    `select nt.id, nt."categoryId"
     from "NotableTransaction" nt
     join "BankAccount" ba on ba.id = nt."bankAccountId"
     join "User" u on u.id = ba."userId"
     where u.email = $1
     order by nt."occurredAt" desc
     limit 1`,
    [E2E_EMAIL],
  );
  if (rows.rows.length === 0) {
    throw new Error("No seeded transactions found for the e2e test user — run `npm run db:seed` before the e2e suite.");
  }
  realTransactionId = rows.rows[0].id;
  realCategoryId = rows.rows[0].categoryId;

  const categories = await db.query<{ id: string }>(
    `select c.id
     from "Category" c
     join "User" u on u.id = c."userId"
     where u.email = $1 and c.id != $2
     limit 1`,
    [E2E_EMAIL, realCategoryId],
  );
  otherCategoryId = categories.rows[0].id;
});

test.afterAll(async () => {
  await db.end();
});

test.describe("security headers", () => {
  test("dashboard response carries the full hardened header set", async ({ page }) => {
    const response = await page.goto("/dashboard");
    expect(response).not.toBeNull();
    const headers = response!.headers();

    expect(headers["strict-transport-security"]).toContain("max-age=63072000");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["permissions-policy"]).toContain("camera=()");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["x-powered-by"]).toBeUndefined();

    const csp = headers["content-security-policy"];
    expect(csp).toBeDefined();
    expect(csp).toMatch(/script-src[^;]*'nonce-[A-Za-z0-9+/=]+'/);
    expect(csp).toContain("'strict-dynamic'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("unsafe-inline");
    // NOT `.not.toContain("unsafe-eval")` — a real false positive this
    // pass caught: the CSP legitimately carries `'wasm-unsafe-eval'`
    // (§3q/§3u, scoped narrowly to WASM compilation for the client-side
    // OCR/embedding engines), which contains "unsafe-eval" as a
    // substring despite being a genuinely different, narrower token than
    // the broad `'unsafe-eval'` this check exists to catch. A
    // word-boundary regex distinguishes the two; a plain substring check
    // can't.
    expect(csp).not.toMatch(/(?<!wasm-)unsafe-eval/);
  });
});

test.describe("CSRF / Origin verification", () => {
  test("a forged cross-origin Origin header is rejected with 403", async ({ request, baseURL }) => {
    const response = await request.patch(`${baseURL}/api/transactions/${realTransactionId}`, {
      headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
      data: { categoryId: otherCategoryId },
    });
    expect(response.status()).toBe(403);
  });

  test("a matching same-origin request is not rejected on Origin grounds", async ({ request, baseURL }) => {
    const response = await request.patch(`${baseURL}/api/transactions/${realTransactionId}`, {
      headers: { Origin: baseURL!, "Content-Type": "application/json" },
      data: { categoryId: otherCategoryId },
    });
    // Proves the *positive* path works too — a 403 here would mean the
    // Origin check is over-broad, not just that it correctly blocks evil.example.
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, categoryId: otherCategoryId });

    // Restore, so this test is order-independent / repeatable.
    await request.patch(`${baseURL}/api/transactions/${realTransactionId}`, {
      headers: { Origin: baseURL!, "Content-Type": "application/json" },
      data: { categoryId: realCategoryId },
    });
  });
});

test.describe("IDOR / not-found handling", () => {
  test("a nonexistent transaction id returns 404, never 403, with no stack trace", async ({ request, baseURL }) => {
    const response = await request.patch(`${baseURL}/api/transactions/does-not-exist-at-all`, {
      headers: { Origin: baseURL!, "Content-Type": "application/json" },
      data: { categoryId: realCategoryId },
    });
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(body).toEqual({ error: "Not found" });
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/at .*\.(ts|tsx|js):\d+/); // no stack frame leaked
  });
});

test.describe("SQL injection fuzzing", () => {
  const PAYLOADS = ["' OR '1'='1", "'; DROP TABLE \"NotableTransaction\"; --", "1' UNION SELECT NULL--"];

  for (const payload of PAYLOADS) {
    // `q` is the free-text search filter (applied in application code,
    // post-decryption — see AGENTS.md on why `description` can't be
    // pushed to a DB `where` clause); `category` goes straight into a
    // Prisma `where: { categoryId }` clause. Both are exercised since
    // they reach the database through different code paths.
    test(`/transactions?q=${payload} doesn't error or leak a stack trace`, async ({ page }) => {
      const response = await page.goto(`/transactions?q=${encodeURIComponent(payload)}`);
      expect(response!.status()).toBe(200);
      const text = await page.content();
      expect(text).not.toMatch(/PrismaClientKnownRequestError|at eval|node_modules\//);
    });

    test(`/transactions?category=${payload} doesn't error or leak a stack trace`, async ({ page }) => {
      const response = await page.goto(`/transactions?category=${encodeURIComponent(payload)}`);
      expect(response!.status()).toBe(200);
      const text = await page.content();
      expect(text).not.toMatch(/PrismaClientKnownRequestError|at eval|node_modules\//);
    });
  }

  test("the fuzzed table still exists afterward (no DROP TABLE succeeded)", async () => {
    const result = await db.query('select count(*) from "NotableTransaction"');
    expect(Number(result.rows[0].count)).toBeGreaterThan(0);
  });
});

test.describe("rate limiting", () => {
  test("the 31st rapid PATCH to the same route from the same user gets 429", async ({ request, baseURL }) => {
    let sawTooManyRequests = false;
    let lastStatus = 0;

    for (let i = 0; i < 31; i += 1) {
      const response = await request.patch(`${baseURL}/api/transactions/${realTransactionId}`, {
        headers: { Origin: baseURL!, "Content-Type": "application/json" },
        data: { categoryId: realCategoryId },
      });
      lastStatus = response.status();
      if (lastStatus === 429) {
        sawTooManyRequests = true;
        expect(response.headers()["retry-after"]).toBeDefined();
        break;
      }
    }

    expect(sawTooManyRequests, `never got a 429 across 31 requests (last status: ${lastStatus})`).toBe(true);
  });
});

test.describe("stored XSS", () => {
  const PAYLOAD = '<img src=x onerror="window.__pfw_xss_fired = true">';
  let originalMerchantName: string | null;

  test.beforeAll(async () => {
    const before = await db.query<{ merchantName: string | null }>(
      'select "merchantName" from "NotableTransaction" where id = $1',
      [realTransactionId],
    );
    originalMerchantName = before.rows[0]?.merchantName ?? null;
    await db.query('update "NotableTransaction" set "merchantName" = $1 where id = $2', [
      PAYLOAD,
      realTransactionId,
    ]);
  });

  test.afterAll(async () => {
    await db.query('update "NotableTransaction" set "merchantName" = $1 where id = $2', [
      originalMerchantName,
      realTransactionId,
    ]);
  });

  test("a script-bearing merchant name renders as inert text, never executes", async ({ page }) => {
    await page.goto("/transactions");
    await page.waitForLoadState("networkidle");

    const fired = await page.evaluate(() => (window as { __pfw_xss_fired?: boolean }).__pfw_xss_fired);
    expect(fired).toBeUndefined();

    // The payload should be visible as literal text (React's default
    // escaping), not vanish or get interpreted as markup.
    await expect(page.getByText(PAYLOAD, { exact: false }).first()).toBeVisible();
  });
});
