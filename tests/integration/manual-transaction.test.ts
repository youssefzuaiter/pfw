import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import { BankAccountNotFoundError } from "../../src/server/dal/transaction-import";
import { createTransaction } from "../../src/server/dal/transactions";
import { deleteTestUsersWithLedgerCommits } from "./ledger-commit-test-helpers";

/**
 * Integration coverage for manual transaction creation (AGENTS.md §3q) —
 * the receipt scanner's write path, and the first code path in this app
 * that creates a `NotableTransaction` outside CSV import or the seed
 * script. Same IDOR convention as tests/integration/idor.test.ts: a bank
 * account that isn't the caller's must be indistinguishable from one
 * that doesn't exist.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("createTransaction", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let userA: { id: string };
  let userB: { id: string };
  let accountA: { id: string };
  let uncategorizedA: { id: string };
  let diningA: { id: string };

  beforeAll(async () => {
    admin = createAdminClient();
    userA = await admin.user.create({
      data: { email: `manual-txn-test-a-${Date.now()}@pfw.local`, displayName: "Manual Txn Test A" },
    });
    userB = await admin.user.create({
      data: { email: `manual-txn-test-b-${Date.now()}@pfw.local`, displayName: "Manual Txn Test B" },
    });

    accountA = await admin.bankAccount.create({
      data: { userId: userA.id, institutionName: "Test Bank", last4: "1234", accountType: "CHECKING", nativeBalance: 10_000n },
    });
    uncategorizedA = await admin.category.create({
      data: { userId: userA.id, slug: "uncategorized", name: "Uncategorized", isUncategorized: true },
    });
    diningA = await admin.category.create({
      data: { userId: userA.id, slug: "dining", name: "Dining" },
    });
  });

  afterAll(async () => {
    await deleteTestUsersWithLedgerCommits(admin, [userA.id, userB.id]);
    await admin.$disconnect();
  });

  it("creates a transaction owned by the correct user, flagged isManual", async () => {
    const created = await createTransaction(userA.id, {
      bankAccountId: accountA.id,
      amountAgorot: -2690n,
      occurredAt: new Date("2026-03-05T00:00:00.000Z"),
      description: "Cafe Aroma",
      merchantName: "Cafe Aroma",
    });

    expect(created.userId).toBe(userA.id);
    expect(created.isManual).toBe(true);
    expect(created.amount).toBe(-2690n);
    expect(created.currency).toBe("ILS");

    // createAdminClient() also has the encrypted-fields extension applied
    // (it needs to, for the seed script's own writes) — so a normal read
    // through it, like this one, auto-decrypts just like the app runtime
    // client does. Proving ciphertext-at-rest instead requires reading
    // the raw column directly, bypassing the extension.
    const decrypted = await admin.notableTransaction.findUniqueOrThrow({ where: { id: created.id } });
    expect(decrypted.description).toBe("Cafe Aroma");

    const [rawRow] = await admin.$queryRaw<{ description: string }[]>`
      SELECT description FROM "NotableTransaction" WHERE id = ${created.id}
    `;
    expect(rawRow.description.startsWith("v1:")).toBe(true);
  });

  it("neutralizes formula-injection-looking free text before storing it", async () => {
    const created = await createTransaction(userA.id, {
      bankAccountId: accountA.id,
      amountAgorot: -100n,
      occurredAt: new Date(),
      description: '=HYPERLINK("http://evil.example","Click")',
      merchantName: "=cmd",
    });

    // Decrypt via the same DAL read path a screen would use.
    const fetched = await admin.notableTransaction.findUniqueOrThrow({ where: { id: created.id } });
    expect(fetched.merchantName).toBe("'=cmd");
  });

  it("throws BankAccountNotFoundError for a bank account belonging to another user (IDOR)", async () => {
    await expect(
      createTransaction(userB.id, {
        bankAccountId: accountA.id,
        amountAgorot: -100n,
        occurredAt: new Date(),
        description: "Should not be allowed",
      }),
    ).rejects.toThrow(BankAccountNotFoundError);
  });

  it("throws BankAccountNotFoundError for a nonexistent bank account", async () => {
    await expect(
      createTransaction(userA.id, {
        bankAccountId: "does-not-exist",
        amountAgorot: -100n,
        occurredAt: new Date(),
        description: "Should not be allowed",
      }),
    ).rejects.toThrow(BankAccountNotFoundError);
  });

  it("learns from a prior manual correction for the same merchant (Tier 1)", async () => {
    const first = await createTransaction(userA.id, {
      bankAccountId: accountA.id,
      amountAgorot: -5000n,
      occurredAt: new Date("2026-01-01T00:00:00.000Z"),
      description: "Very Specific Cafe",
      merchantName: "Very Specific Cafe",
    });
    // Simulate the user correcting it by hand (clears needsReview, same as updateTransactionCategory).
    await admin.notableTransaction.update({
      where: { id: first.id },
      data: { categoryId: diningA.id, needsReview: false },
    });

    const second = await createTransaction(userA.id, {
      bankAccountId: accountA.id,
      amountAgorot: -4500n,
      occurredAt: new Date("2026-02-01T00:00:00.000Z"),
      description: "Very Specific Cafe",
      merchantName: "Very Specific Cafe",
    });

    expect(second.categoryId).toBe(diningA.id);
    expect(second.needsReview).toBe(false);
  });

  it("falls back to Uncategorized with needsReview when nothing matches", async () => {
    const created = await createTransaction(userA.id, {
      bankAccountId: accountA.id,
      amountAgorot: -100n,
      occurredAt: new Date(),
      description: "Totally Unrecognizable Merchant Xyz123",
      merchantName: "Totally Unrecognizable Merchant Xyz123",
    });

    expect(created.categoryId).toBe(uncategorizedA.id);
    expect(created.needsReview).toBe(true);
  });
});
