import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import { getLedgerHistory, verifyLedgerChain, type LedgerCommitState } from "../../src/server/dal/ledger-commits";
import { createTransaction, updateTransactionCategory } from "../../src/server/dal/transactions";
import { deleteTestUsersWithLedgerCommits } from "./ledger-commit-test-helpers";

/**
 * Integration coverage for Cryptographic Ledger Versioning (ad hoc,
 * AGENTS.md) — proves the hash chain is actually built correctly against
 * real Postgres (not just asserted correct from the pure hash-function
 * unit tests in src/lib/ledger-hash.test.ts), that tampering is
 * detectable, that the append-only trigger genuinely fires even for the
 * admin/superuser role, and that cross-user access is denied by RLS —
 * same conventions as tests/integration/manual-transaction.test.ts and
 * tests/integration/idor.test.ts.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("Cryptographic Ledger Versioning", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let userA: { id: string };
  let userB: { id: string };
  let accountA: { id: string };
  let groceriesA: { id: string; name: string };
  let diningA: { id: string; name: string };

  beforeAll(async () => {
    admin = createAdminClient();
    userA = await admin.user.create({
      data: { email: `ledger-test-a-${Date.now()}@pfw.local`, displayName: "Ledger Test A" },
    });
    userB = await admin.user.create({
      data: { email: `ledger-test-b-${Date.now()}@pfw.local`, displayName: "Ledger Test B" },
    });

    accountA = await admin.bankAccount.create({
      data: { userId: userA.id, institutionName: "Test Bank", last4: "1234", accountType: "CHECKING", nativeBalance: 10_000n },
    });
    await admin.category.create({
      data: { userId: userA.id, slug: "uncategorized", name: "Uncategorized", isUncategorized: true },
    });
    groceriesA = await admin.category.create({ data: { userId: userA.id, slug: "groceries", name: "Groceries" } });
    diningA = await admin.category.create({ data: { userId: userA.id, slug: "dining", name: "Dining" } });
  });

  afterAll(async () => {
    // A cascading DELETE from User still fires LedgerCommit's own BEFORE
    // DELETE trigger (Postgres implements ON DELETE CASCADE as a real
    // DELETE against the child table) — this needs the same trigger-
    // disable dance the append-only design requires everywhere else a
    // ledger-committed user is ever removed (see
    // ledger-commit-test-helpers.ts's own doc comment, and
    // prisma/seed/index.ts's identical precedent for AuditLog).
    await deleteTestUsersWithLedgerCommits(admin, [userA.id, userB.id]);
    await admin.$disconnect();
  });

  it("records a CREATE commit with previousHash null, and its currentHash matches an independent recomputation", async () => {
    const created = await createTransaction(userA.id, {
      bankAccountId: accountA.id,
      amountAgorot: -4500n,
      occurredAt: new Date("2026-09-01T10:00:00.000Z"),
      description: "Supermarket",
      merchantName: "Supermarket Co",
    });

    const history = await getLedgerHistory(userA.id, created.id);
    expect(history).toHaveLength(1);
    expect(history[0].action).toBe("CREATE");
    expect(history[0].previousHash).toBeNull();
    expect(history[0].patchData.amountAgorot).toBe("-4500");

    const verification = await verifyLedgerChain(userA.id, created.id);
    expect(verification).toEqual({ valid: true, brokenAtCommitId: null });
  });

  it("chains an UPDATE commit's previousHash to the CREATE commit's currentHash", async () => {
    const created = await createTransaction(userA.id, {
      bankAccountId: accountA.id,
      amountAgorot: -2000n,
      occurredAt: new Date("2026-09-02T10:00:00.000Z"),
      description: "Grocery run",
      merchantName: "Grocery run",
    });

    await updateTransactionCategory(userA.id, created.id, groceriesA.id);

    const history = await getLedgerHistory(userA.id, created.id);
    expect(history).toHaveLength(2);
    expect(history[0].action).toBe("CREATE");
    expect(history[1].action).toBe("UPDATE");
    expect(history[1].previousHash).toBe(history[0].currentHash);
    expect(history[1].patchData.categoryName).toBe("Groceries");

    const verification = await verifyLedgerChain(userA.id, created.id);
    expect(verification.valid).toBe(true);
  });

  it("a second UPDATE extends the chain correctly (three commits, each linked to the previous)", async () => {
    const created = await createTransaction(userA.id, {
      bankAccountId: accountA.id,
      amountAgorot: -3000n,
      occurredAt: new Date("2026-09-03T10:00:00.000Z"),
      description: "Recategorize me twice",
      merchantName: "Recategorize me twice",
    });
    await updateTransactionCategory(userA.id, created.id, groceriesA.id);
    await updateTransactionCategory(userA.id, created.id, diningA.id);

    const history = await getLedgerHistory(userA.id, created.id);
    expect(history).toHaveLength(3);
    expect(history[1].previousHash).toBe(history[0].currentHash);
    expect(history[2].previousHash).toBe(history[1].currentHash);
    expect(history[2].patchData.categoryName).toBe("Dining");

    const verification = await verifyLedgerChain(userA.id, created.id);
    expect(verification.valid).toBe(true);
  });

  it("detects a tampered/bogus commit inserted out of band — the actual point of the chain", async () => {
    const created = await createTransaction(userA.id, {
      bankAccountId: accountA.id,
      amountAgorot: -1000n,
      occurredAt: new Date("2026-09-04T10:00:00.000Z"),
      description: "Will be tampered",
      merchantName: "Will be tampered",
    });

    // The append-only trigger blocks UPDATE/DELETE on an EXISTING row,
    // but grants alone don't stop a bogus INSERT — pfw_runtime genuinely
    // has INSERT rights (that's how legitimate commits get written at
    // all). This simulates exactly that: a structurally valid row whose
    // currentHash doesn't match what its own patchData/previousHash
    // actually hash to, inserted directly via the admin client, bypassing
    // appendLedgerCommit's real chain logic entirely.
    const bogusState: LedgerCommitState = {
      transactionId: created.id,
      categoryId: groceriesA.id,
      categoryName: "Groceries",
      amountAgorot: "-999999",
      currency: "ILS",
      nativeAmount: "-999999",
      occurredAtIso: new Date().toISOString(),
      description: "forged",
      merchantName: "forged",
    };
    await admin.ledgerCommit.create({
      data: {
        userId: userA.id,
        transactionId: created.id,
        action: "UPDATE",
        previousHash: "not-the-real-previous-hash",
        currentHash: "0000000000000000000000000000000000000000000000000000000000000",
        patchData: bogusState,
      },
    });

    const verification = await verifyLedgerChain(userA.id, created.id);
    expect(verification.valid).toBe(false);
    expect(verification.brokenAtCommitId).not.toBeNull();
  });

  it("the append-only trigger rejects UPDATE and DELETE even for the admin/superuser role", async () => {
    const created = await createTransaction(userA.id, {
      bankAccountId: accountA.id,
      amountAgorot: -500n,
      occurredAt: new Date(),
      description: "Immutability check",
      merchantName: "Immutability check",
    });
    const [commit] = await getLedgerHistory(userA.id, created.id);

    await expect(admin.ledgerCommit.update({ where: { id: commit.id }, data: { currentHash: "tampered" } })).rejects.toThrow();
    await expect(admin.ledgerCommit.delete({ where: { id: commit.id } })).rejects.toThrow();
  });

  it("RLS denies cross-user access to another user's ledger history (IDOR)", async () => {
    const created = await createTransaction(userA.id, {
      bankAccountId: accountA.id,
      amountAgorot: -750n,
      occurredAt: new Date(),
      description: "User A's transaction",
      merchantName: "User A's transaction",
    });

    // userB has no row for this transactionId at all under their own RLS
    // scope — the query runs, it just returns nothing, same "404, never
    // 403" IDOR shape this app uses everywhere else.
    const asUserB = await getLedgerHistory(userB.id, created.id);
    expect(asUserB).toEqual([]);

    const asUserA = await getLedgerHistory(userA.id, created.id);
    expect(asUserA.length).toBeGreaterThan(0);
  });
});
