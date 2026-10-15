import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convertNativeToAgorotExact, rateMicrosFromDecimal } from "../../src/lib/fx-history";
import { createAdminClient } from "../../src/server/db/admin-client";
import { withUserScope } from "../../src/server/db/with-user-scope";
import { appendLedgerCommit, buildLedgerState, getLedgerHistory, verifyLedgerChain } from "../../src/server/dal/ledger-commits";
import { createTransaction, EnteredAmountMismatchError } from "../../src/server/dal/transactions";
import { deleteTestUsersWithLedgerCommits } from "./ledger-commit-test-helpers";

/**
 * A transaction typed in a foreign currency (AGENTS.md §3www), against real
 * Postgres: the four stored fields agree to the agorah, the CREATE commit
 * hashes the rate, and verification catches a row whose amount or rate was
 * edited behind the app's back, while a commit written before rates were
 * hashed, and a category rename, are not mistaken for tampering.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("foreign-currency transaction entry", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let user: { id: string };
  let account: { id: string };
  let groceries: { id: string };

  beforeAll(async () => {
    admin = createAdminClient();
    user = await admin.user.create({ data: { email: `fx-entry-${Date.now()}@pfw.local`, displayName: "FX Entry" } });
    account = await admin.bankAccount.create({
      data: { userId: user.id, institutionName: "FX Bank", last4: "4242", accountType: "CHECKING", currency: "TRY", nativeBalance: 0n },
    });
    await admin.category.create({ data: { userId: user.id, slug: "uncategorized", name: "Uncategorized", isUncategorized: true } });
    groceries = await admin.category.create({ data: { userId: user.id, slug: "groceries", name: "Groceries" } });
  });

  afterAll(async () => {
    await deleteTestUsersWithLedgerCommits(admin, [user.id]);
    await admin.$disconnect();
  });

  async function enterUsd(nativeAmount: bigint, rate: string, description: string) {
    const amountAgorot = BigInt(convertNativeToAgorotExact(nativeAmount, rateMicrosFromDecimal(rate)));
    return createTransaction(user.id, {
      bankAccountId: account.id,
      amountAgorot,
      occurredAt: new Date("2026-10-09T12:00:00.000Z"),
      description,
      merchantName: description,
      entered: { currency: "USD", nativeAmount, exchangeRate: rate },
    });
  }

  it("stores the entered amount, its currency, the locked rate and the exact shekel figure", async () => {
    const created = await enterUsd(-4_990n, "3.037667", "Book store");
    const stored = await admin.notableTransaction.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored.currency).toBe("USD");
    expect(stored.nativeAmount).toBe(-4_990n);
    expect(stored.exchangeRateAtEntry?.toFixed(6)).toBe("3.037667");
    expect(stored.amount).toBe(-15_158n); // -49.90 × 3.037667 = -151.5795833 → -₪151.58
    // The stored rate × the stored entered amount reproduces the stored shekels, exactly.
    expect(BigInt(convertNativeToAgorotExact(stored.nativeAmount, rateMicrosFromDecimal(stored.exchangeRateAtEntry!.toFixed(6))))).toBe(stored.amount);
    // Entered in dollars into a lira account: the row records what was typed.
    expect(stored.bankAccountId).toBe(account.id);
  });

  it("stores an exact half agorah rounded away from zero, where a float product would round down", async () => {
    const created = await enterUsd(100_000n, "0.285085", "Half agorah");
    const stored = await admin.notableTransaction.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored.amount).toBe(28_509n);
  });

  it("hashes the rate into the CREATE commit, and the chain and the row both verify", async () => {
    const created = await enterUsd(-1_234n, "3.040001", "Hashed rate");
    const [commit] = await getLedgerHistory(user.id, created.id);
    expect(commit.patchData).toMatchObject({ currency: "USD", nativeAmount: "-1234", amountAgorot: "-3751", exchangeRate: "3.040001" });
    expect(await verifyLedgerChain(user.id, created.id)).toEqual({ valid: true, brokenAtCommitId: null, mismatchedFields: [] });
  });

  it("refuses an amount that is not the entered amount at the entered rate, writing nothing", async () => {
    const before = await admin.notableTransaction.count({ where: { userId: user.id } });
    await expect(
      createTransaction(user.id, {
        bankAccountId: account.id,
        amountAgorot: -15_157n, // one agorah off
        occurredAt: new Date("2026-10-09T12:00:00.000Z"),
        description: "Off by one",
        entered: { currency: "USD", nativeAmount: -4_990n, exchangeRate: "3.037667" },
      }),
    ).rejects.toThrow(EnteredAmountMismatchError);
    expect(await admin.notableTransaction.count({ where: { userId: user.id } })).toBe(before);
  });

  it("catches a rate or amount edited directly in the database", async () => {
    const rateEdited = await enterUsd(-2_000n, "3.037667", "Rate edited");
    await admin.notableTransaction.update({ where: { id: rateEdited.id }, data: { exchangeRateAtEntry: "3.137667" } });
    const [head] = await getLedgerHistory(user.id, rateEdited.id);
    expect(await verifyLedgerChain(user.id, rateEdited.id)).toEqual({ valid: false, brokenAtCommitId: head.id, mismatchedFields: ["exchangeRate"] });

    const amountEdited = await enterUsd(-2_000n, "3.037667", "Amount edited");
    await admin.notableTransaction.update({ where: { id: amountEdited.id }, data: { amount: -1n } });
    expect((await verifyLedgerChain(user.id, amountEdited.id)).mismatchedFields).toEqual(["amountAgorot"]);
  });

  it("does not mistake a category rename, or a commit from before rates were hashed, for tampering", async () => {
    const created = await enterUsd(-500n, "3.037667", "Renamed category");
    await admin.category.update({ where: { id: created.categoryId }, data: { name: `Renamed ${Date.now()}` } });
    expect((await verifyLedgerChain(user.id, created.id)).valid).toBe(true);

    // A foreign row whose only commit has no `exchangeRate` key, as every
    // commit written before §3www does.
    const legacy = await admin.notableTransaction.create({
      data: {
        userId: user.id,
        bankAccountId: account.id,
        categoryId: groceries.id,
        occurredAt: new Date("2026-09-01T00:00:00.000Z"),
        currency: "USD",
        nativeAmount: -1_000n,
        amount: -3_700n,
        exchangeRateAtEntry: "3.700000",
        description: "Before rates were hashed",
      },
    });
    const { exchangeRate: _omitted, ...stateWithoutRate } = buildLedgerState({ ...legacy, categoryName: "Groceries" });
    void _omitted;
    await withUserScope(user.id, (tx) => appendLedgerCommit(tx, user.id, { transactionId: legacy.id, action: "CREATE", state: stateWithoutRate }));
    expect(await verifyLedgerChain(user.id, legacy.id)).toEqual({ valid: true, brokenAtCommitId: null, mismatchedFields: [] });
  });
});
