import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import { getCurrentUser } from "../../src/server/auth/current-user";
import { listUncategorizedForSuggestions } from "../../src/server/dal/category-suggestions";
import { POST as applyPost } from "../../src/app/api/transactions/category-suggestions/apply/route";
import { applyRulesToExistingTransactions } from "../../src/server/dal/transactions";
import { SUGGESTED_RULE_PRIORITY } from "../../src/server/dal/transaction-rules";
import { deleteTestUsersWithLedgerCommits } from "./ledger-commit-test-helpers";

/**
 * The AI category suggestions' two database halves against real Postgres
 * with RLS (AGENTS.md §3kkk): what is read for Claude (only live,
 * non-transfer rows still in Uncategorized, and only the user's own active
 * categories), and what applying writes (only the user's own rows, into the
 * user's own categories, with a ledger commit). Claude itself is never
 * called here; the suggester and the route have their own tests.
 */
vi.mock("../../src/server/auth/current-user", () => ({ getCurrentUser: vi.fn() }));

describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("AI category suggestions", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let userA: { id: string };
  let userB: { id: string };
  let groceriesA: string;
  let groceriesB: string;
  let newestA: string;
  let txB: string;

  beforeAll(async () => {
    admin = createAdminClient();
    const stamp = Date.now();
    userA = await admin.user.create({ data: { email: `suggest-a-${stamp}@pfw.local`, displayName: "Suggest A" } });
    userB = await admin.user.create({ data: { email: `suggest-b-${stamp}@pfw.local`, displayName: "Suggest B" } });

    async function setUp(userId: string) {
      const account = await admin.bankAccount.create({
        data: { userId, institutionName: "QNB", last4: "1234", accountType: "CHECKING", nativeBalance: 0n, currency: "TRY" },
      });
      const uncategorized = await admin.category.create({
        data: { userId, slug: "uncategorized", name: "Uncategorized", isUncategorized: true },
      });
      const groceries = await admin.category.create({ data: { userId, slug: "groceries", name: "Groceries" } });
      return { accountId: account.id, uncategorizedId: uncategorized.id, groceriesId: groceries.id };
    }
    const a = await setUp(userA.id);
    const b = await setUp(userB.id);
    groceriesA = a.groceriesId;
    groceriesB = b.groceriesId;
    await admin.category.create({ data: { userId: userA.id, slug: "old", name: "Old", archivedAt: new Date() } });

    async function tx(userId: string, accountId: string, categoryId: string, day: number, description: string, extra = {}) {
      const row = await admin.notableTransaction.create({
        data: {
          userId, bankAccountId: accountId, categoryId, currency: "TRY",
          occurredAt: new Date(Date.UTC(2026, 9, day)), amount: -1_000n, nativeAmount: -10_000n,
          description, merchantName: description.toUpperCase(), isManual: false, needsReview: true, ...extra,
        },
      });
      return row.id;
    }
    await tx(userA.id, a.accountId, a.uncategorizedId, 1, "oldest coffee");
    await tx(userA.id, a.accountId, a.uncategorizedId, 2, "middle market");
    newestA = await tx(userA.id, a.accountId, a.uncategorizedId, 3, "newest bakery");
    await tx(userA.id, a.accountId, a.uncategorizedId, 4, "own account transfer", { isTransfer: true });
    await tx(userA.id, a.accountId, a.uncategorizedId, 5, "deleted row", { deletedAt: new Date() });
    await tx(userA.id, a.accountId, a.groceriesId, 6, "already groceries");
    txB = await tx(userB.id, b.accountId, b.uncategorizedId, 3, "someone else's row");
  });

  afterAll(async () => {
    // Applying writes an AuditLog row and a LedgerCommit, both append-only:
    // a cascading delete is refused by their triggers, so use the shared
    // helper (one lock order, retried on deadlock).
    await deleteTestUsersWithLedgerCommits(admin, [userA.id, userB.id]);
    await admin.$disconnect();
  });

  it("reads only live, non-transfer, uncategorized rows, newest first, with descriptions decrypted", async () => {
    const data = await listUncategorizedForSuggestions(userA.id, 10);
    expect(data.total).toBe(3);
    expect(data.rows.map((r) => r.description)).toEqual(["newest bakery", "middle market", "oldest coffee"]);
    expect(data.categories).toEqual([{ id: groceriesA, slug: "groceries", name: "Groceries" }]); // no Uncategorized, no archived
  });

  it("stops at the limit but still counts every row", async () => {
    const data = await listUncategorizedForSuggestions(userA.id, 2);
    expect(data.total).toBe(3);
    expect(data.rows).toHaveLength(2);
  });

  it("never reads another user's rows or categories (RLS)", async () => {
    const data = await listUncategorizedForSuggestions(userB.id, 10);
    expect(data.rows.map((r) => r.description)).toEqual(["someone else's row"]);
    expect(data.categories).toEqual([{ id: groceriesB, slug: "groceries", name: "Groceries" }]);
  });

  it("applies only the user's own rows into the user's own categories, with a ledger commit", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(userA as never);
    const response = await applyPost(
      new NextRequest("http://localhost:3000/api/transactions/category-suggestions/apply", {
        method: "POST",
        headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json" },
        body: JSON.stringify({
          choices: [
            { transactionId: newestA, categoryId: groceriesA },
            { transactionId: txB, categoryId: groceriesA }, // not A's transaction
            { transactionId: newestA, categoryId: groceriesB }, // not A's category
          ],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, updated: 1, skipped: 2, rulesCreated: 0, rulesSkipped: 0 });

    const updated = await admin.notableTransaction.findUniqueOrThrow({ where: { id: newestA } });
    expect(updated.categoryId).toBe(groceriesA);
    expect(updated.needsReview).toBe(false);
    const commits = await admin.ledgerCommit.findMany({ where: { transactionId: newestA } });
    expect(commits.map((c) => c.action)).toEqual(["UPDATE"]);

    const untouched = await admin.notableTransaction.findUniqueOrThrow({ where: { id: txB } });
    expect(untouched.categoryId).not.toBe(groceriesA);
  });

  function applyWithRules(rules: unknown[]) {
    vi.mocked(getCurrentUser).mockResolvedValue(userA as never);
    return applyPost(
      new NextRequest("http://localhost:3000/api/transactions/category-suggestions/apply", {
        method: "POST",
        headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json" },
        body: JSON.stringify({ choices: [{ transactionId: newestA, categoryId: groceriesA }], rules }),
      }),
    );
  }

  it("saves accepted suggestions as rules that sort matching transactions, skipping another user's category and repeats (AGENTS.md §3ooo)", async () => {
    const response = await applyWithRules([
      { field: "description", keyword: "market", categoryId: groceriesA },
      { field: "description", keyword: "Market", categoryId: groceriesA }, // the same rule again, differently cased
      { field: "merchantName", keyword: "COFFEE", categoryId: groceriesB }, // not A's category
    ]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ rulesCreated: 1, rulesSkipped: 2 });

    const rules = await admin.transactionRule.findMany({ where: { userId: userA.id } });
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      name: "market → Groceries",
      priority: SUGGESTED_RULE_PRIORITY,
      isActive: true,
      conditions: [{ field: "description", operator: "contains", value: "market" }],
      actions: [{ type: "categorize", categorySlug: "groceries" }],
    });

    // The saved rule really sorts the matching row (a dry run writes nothing).
    const preview = await applyRulesToExistingTransactions(userA.id, { dryRun: true });
    expect(preview.changes.map((change) => [change.label, change.categoryTo])).toEqual([["MIDDLE MARKET", "Groceries"]]);
    expect(await admin.transactionRule.count({ where: { userId: userB.id } })).toBe(0);
  });

  it("never saves a second rule for a word that already has one", async () => {
    const response = await applyWithRules([{ field: "description", keyword: "MARKET", categoryId: groceriesA }]);
    expect(await response.json()).toMatchObject({ rulesCreated: 0, rulesSkipped: 1 });
    expect(await admin.transactionRule.count({ where: { userId: userA.id } })).toBe(1);
  });

  it("refuses a malformed rule rather than saving it", async () => {
    const response = await applyWithRules([{ field: "amount", keyword: "100", categoryId: groceriesA }]);
    expect(response.status).toBe(400);
    expect(await admin.transactionRule.count({ where: { userId: userA.id } })).toBe(1);
  });
});
