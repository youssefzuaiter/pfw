import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getCurrentUser } from "../../src/server/auth/current-user";
import { createAdminClient } from "../../src/server/db/admin-client";
import { ORIGIN_CHECK_EXEMPT, SWEPT_ROUTES } from "../routes/mutating-route-registry";

/**
 * Safety net for the mutating routes (AGENTS.md §2, Section 2.4). Every swept
 * route is called with a throwaway user and two kinds of request:
 *  1. a forged Origin, which must be refused with 403 before anything runs;
 *  2. a valid Origin with an empty body and a nonexistent id, which must not
 *     answer 500. A 400, 404 or 409 is a correct refusal.
 *
 * The identity is injected by mocking getCurrentUser: the route code, the
 * Origin guard, validation, the rate limiter and the DAL all run for real
 * against Postgres with RLS. Auth.js sessions are not involved here; the
 * proxy has its own tests.
 *
 * It asserts status codes only, not business outcomes. Its job is to catch a
 * route that crashes, which is what the category-delete bug did for months.
 */
vi.mock("../../src/server/auth/current-user", () => ({ getCurrentUser: vi.fn() }));

const routeModules = import.meta.glob("../../src/app/api/**/route.ts");

const FAKE_ID = "cnonexistent0000000000000";
const TRUSTED_ORIGIN = "http://localhost:3000";
const FORGED_ORIGIN = "https://evil.example";

type Handler = (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

type Target = { id: string; body: string | undefined };

async function callRoute(routeKey: string, origin: string, target: Target): Promise<Response> {
  const [method, path] = routeKey.split(" ") as [string, string];
  const loader = routeModules[`../../src/app${path}/route.ts`];
  if (!loader) throw new Error(`no route file for ${routeKey}`);
  const routeModule = (await loader()) as Record<string, Handler | undefined>;
  const handler = routeModule[method];
  if (!handler) throw new Error(`${routeKey} has no ${method} handler`);

  const segments = [...path.matchAll(/\[(\w+)\]/g)].map((match) => match[1] as string);
  const params = Object.fromEntries(segments.map((name) => [name, target.id]));
  const url = `${TRUSTED_ORIGIN}${path.replace(/\[(\w+)\]/g, target.id)}`;

  const headers = new Headers({ host: "localhost:3000", origin });
  if (target.body !== undefined) headers.set("content-type", "application/json");
  const request = new NextRequest(url, {
    method,
    headers,
    body: target.body,
  });
  return handler(request, { params: Promise.resolve(params) });
}

const NO_BODY: Target = { id: FAKE_ID, body: undefined };
const EMPTY_JSON = "{}";

/**
 * Routes that act on an existing record. A nonexistent id returns 404 before
 * the route does any real work, so these get a record that belongs to the
 * throwaway user. The category-delete crash (AGENTS.md's regression note in
 * tests/integration/category-delete.test.ts) only happened on a real category.
 */
const REAL_TARGET_ROUTES = new Set([
  "DELETE /api/categories/[id]",
  "PATCH /api/categories/[id]",
  "PATCH /api/transactions/[id]",
  "POST /api/transactions/[id]/delete",
  "POST /api/transactions/[id]/transfer",
]);

describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("mutating route sweep", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let user: { id: string };
  let bankAccountId: string;
  let uncategorizedId: string;

  beforeAll(async () => {
    admin = createAdminClient();
    user = await admin.user.create({
      data: { email: `route-sweep-${Date.now()}@pfw.local`, displayName: "Route Sweep" },
    });
    vi.mocked(getCurrentUser).mockResolvedValue(user as never);
    const account = await admin.bankAccount.create({
      data: { userId: user.id, institutionName: "Sweep Bank", last4: "0000", accountType: "CHECKING", nativeBalance: 0n },
    });
    bankAccountId = account.id;
    const uncategorized = await admin.category.create({
      data: { userId: user.id, slug: "uncategorized", name: "Uncategorized", isUncategorized: true },
    });
    uncategorizedId = uncategorized.id;
  });

  /** A fresh record for each call, owned by the throwaway user. */
  async function targetFor(routeKey: string): Promise<Target> {
    if (!REAL_TARGET_ROUTES.has(routeKey)) return NO_BODY;
    const suffix = Math.random().toString(36).slice(2, 10);
    if (routeKey.includes("/api/categories/")) {
      const category = await admin.category.create({
        data: { userId: user.id, slug: `sweep-${suffix}`, name: `Sweep ${suffix}` },
      });
      return { id: category.id, body: routeKey.startsWith("PATCH") ? JSON.stringify({ name: `Renamed ${suffix}` }) : undefined };
    }
    const transaction = await admin.notableTransaction.create({
      data: {
        userId: user.id, bankAccountId, categoryId: uncategorizedId,
        occurredAt: new Date("2026-09-01T00:00:00.000Z"), amount: -10_000n, nativeAmount: -10_000n,
        description: `Sweep ${suffix}`, isManual: true, needsReview: false,
      },
    });
    const body = routeKey.startsWith("PATCH") ? JSON.stringify({ categoryId: uncategorizedId }) : EMPTY_JSON;
    return { id: transaction.id, body };
  }


  afterAll(async () => {
    // AuditLog and LedgerCommit are append-only; a cascading delete would be
    // refused by their triggers. Disable both for this one delete, in one
    // transaction so a concurrent cleanup cannot interleave (see
    // tests/integration/ledger-commit-test-helpers.ts for why).
    await admin.$transaction(
      async (tx) => {
        await tx.$executeRaw`ALTER TABLE "AuditLog" DISABLE TRIGGER audit_log_append_only`;
        await tx.$executeRaw`ALTER TABLE "LedgerCommit" DISABLE TRIGGER ledger_commit_append_only`;
        await tx.user.deleteMany({ where: { id: user.id } });
        await tx.$executeRaw`ALTER TABLE "AuditLog" ENABLE TRIGGER audit_log_append_only`;
        await tx.$executeRaw`ALTER TABLE "LedgerCommit" ENABLE TRIGGER ledger_commit_append_only`;
      },
      { timeout: 30_000, maxWait: 30_000 },
    );
    await admin.$disconnect();
  });

  describe.each(SWEPT_ROUTES)("%s", (routeKey) => {
    it.skipIf(routeKey in ORIGIN_CHECK_EXEMPT)("refuses a forged origin with 403 before doing anything", async () => {
      const response = await callRoute(routeKey, FORGED_ORIGIN, { id: FAKE_ID, body: EMPTY_JSON });
      expect(response.status).toBe(403);
    });

    it("never answers 500, on a real record where one is needed", async () => {
      const target = await targetFor(routeKey);
      const response = await callRoute(routeKey, TRUSTED_ORIGIN, target);
      expect(response.status).toBeLessThan(500);
    });
  });
});
