import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nativeAmount } from "../../src/lib/currency";
import type { CanonicalImportRow } from "../../src/lib/csv-import/types";
import { createAdminClient } from "../../src/server/db/admin-client";
import {
  BankAccountNotFoundError,
  ImportCurrencyMismatchError,
  type ImportRateSource,
  importTransactions,
  NoExchangeRateError,
} from "../../src/server/dal/transaction-import";
import { deleteTestUsersWithLedgerCommits } from "./ledger-commit-test-helpers";

/**
 * The currency-aware CSV import write path (AGENTS.md §3bbb) against real
 * Postgres: a statement parsed in a foreign-currency account's own
 * currency is booked with its native amount, its ILS conversion at the
 * rate resolved at import time, and that rate frozen onto the row.
 *
 * The rate itself is injected (`rateSource`) — `ExchangeRate` is a
 * global table shared by every parallel test file, so relying on (or
 * mutating) a real TRY row here would race the circuit-breaker suite
 * that edits those same rows. The gate's own logic has DB-free unit
 * coverage in src/server/dal/transaction-import-rate.test.ts.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("importTransactions — multi-currency", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let userA: { id: string };
  let userB: { id: string };
  let tryAccountA: { id: string };
  let ilsAccountA: { id: string };

  /** 1 TRY = ₪0.09 for every day — deliberately NOT a real synced rate, so a real row can't accidentally satisfy the assertions. */
  const fixedRateSource: ImportRateSource = {
    listRatePoints: async () => [{ day: "2020-01-01", micros: 90_000 }],
    syncRateHistory: async () => undefined,
  };
  const noRateSource: ImportRateSource = {
    listRatePoints: async () => [],
    syncRateHistory: async () => undefined,
  };

  function row(
    overrides: Partial<Omit<CanonicalImportRow, "nativeAmount">> & { nativeAmount: number; dedupeKeySource: string },
  ): CanonicalImportRow {
    return {
      lineNumber: 2,
      occurredAt: new Date("2026-03-01T00:00:00.000Z"),
      currency: "TRY",
      description: "MİGROS",
      merchantName: "MİGROS",
      providerReference: null,
      ...overrides,
      nativeAmount: nativeAmount(overrides.nativeAmount),
    };
  }

  beforeAll(async () => {
    admin = createAdminClient();
    const stamp = Date.now();
    userA = await admin.user.create({
      data: { email: `import-currency-a-${stamp}@pfw.local`, displayName: "Import Currency A" },
    });
    userB = await admin.user.create({
      data: { email: `import-currency-b-${stamp}@pfw.local`, displayName: "Import Currency B" },
    });
    tryAccountA = await admin.bankAccount.create({
      data: {
        userId: userA.id,
        institutionName: "QNB (test)",
        last4: "7669",
        accountType: "CHECKING",
        currency: "TRY",
        nativeBalance: 100_000n,
      },
    });
    ilsAccountA = await admin.bankAccount.create({
      data: { userId: userA.id, institutionName: "Leumi (test)", last4: "0001", accountType: "CHECKING", nativeBalance: 0n },
    });
    await admin.category.create({
      data: { userId: userA.id, slug: "uncategorized", name: "Uncategorized", isUncategorized: true },
    });
  });

  afterAll(async () => {
    await deleteTestUsersWithLedgerCommits(admin, [userA.id, userB.id]);
    await admin.$disconnect();
  });

  it("books a TRY row with its native amount, the ILS conversion, and the rate frozen on the row", async () => {
    const summary = await importTransactions(userA.id, {
      bankAccountId: tryAccountA.id,
      adapterId: "turkish-debit-credit",
      rateSource: fixedRateSource,
      rows: [row({ nativeAmount: -123456, dedupeKeySource: "try-1" }), row({ nativeAmount: 4500000, dedupeKeySource: "try-2", description: "MAAŞ", merchantName: null })],
    });

    expect(summary.importedCount).toBe(2);
    const [expense, income] = await Promise.all(
      summary.importedIds.map((id) => admin.notableTransaction.findUniqueOrThrow({ where: { id } })),
    );

    expect(expense.currency).toBe("TRY");
    expect(expense.nativeAmount).toBe(-123456n);
    // -1,234.56 TRY × 0.09 = -111.1104 ILS → -11111 agorot (rounded).
    expect(expense.amount).toBe(-11111n);
    expect(expense.exchangeRateAtEntry?.toString()).toBe("0.09");
    expect(expense.bankAccountId).toBe(tryAccountA.id);
    expect(expense.isManual).toBe(false);

    expect(income.nativeAmount).toBe(4500000n);
    expect(income.amount).toBe(405000n);
  });

  it("re-importing the same rows is a no-op regardless of the rate on the day (native-amount dedupe keys)", async () => {
    const differentRateSource: ImportRateSource = {
      ...fixedRateSource,
      listRatePoints: async () => [{ day: "2020-01-01", micros: 120_000 }],
    };
    const summary = await importTransactions(userA.id, {
      bankAccountId: tryAccountA.id,
      adapterId: "turkish-debit-credit",
      rateSource: differentRateSource,
      rows: [row({ nativeAmount: -123456, dedupeKeySource: "try-1" })],
    });
    expect(summary.importedCount).toBe(0);
    expect(summary.duplicateCount).toBe(1);

    // And the original row was NOT re-priced at the new rate — a booked
    // conversion is a frozen fact.
    const original = await admin.notableTransaction.findFirst({
      where: { userId: userA.id, providerTransactionId: { startsWith: "csv:turkish-debit-credit:hash:" } },
      orderBy: { createdAt: "asc" },
    });
    expect(original?.exchangeRateAtEntry?.toString()).toBe("0.09");
  });

  it("books an ILS row with no conversion and no frozen rate, exactly as before multi-currency", async () => {
    const summary = await importTransactions(userA.id, {
      bankAccountId: ilsAccountA.id,
      adapterId: "generic",
      rateSource: noRateSource, // must never be consulted for ILS
      rows: [row({ nativeAmount: -25000, dedupeKeySource: "ils-1", currency: "ILS", description: "Shufersal", merchantName: null })],
    });
    expect(summary.importedCount).toBe(1);
    const stored = await admin.notableTransaction.findUniqueOrThrow({ where: { id: summary.importedIds[0] } });
    expect(stored.currency).toBe("ILS");
    expect(stored.nativeAmount).toBe(-25000n);
    expect(stored.amount).toBe(-25000n);
    expect(stored.exchangeRateAtEntry).toBeNull();
  });

  it("refuses a foreign-currency import outright when no real rate exists, writing nothing", async () => {
    const before = await admin.notableTransaction.count({ where: { bankAccountId: tryAccountA.id } });
    await expect(
      importTransactions(userA.id, {
        bankAccountId: tryAccountA.id,
        adapterId: "turkish-debit-credit",
        rateSource: noRateSource,
        rows: [row({ nativeAmount: -100, dedupeKeySource: "try-norate" })],
      }),
    ).rejects.toThrow(NoExchangeRateError);
    expect(await admin.notableTransaction.count({ where: { bankAccountId: tryAccountA.id } })).toBe(before);
  });

  it("refuses rows whose currency is not the account's (defense in depth behind the pipeline)", async () => {
    await expect(
      importTransactions(userA.id, {
        bankAccountId: tryAccountA.id,
        adapterId: "generic",
        rateSource: fixedRateSource,
        rows: [row({ nativeAmount: -100, dedupeKeySource: "mismatch", currency: "ILS" })],
      }),
    ).rejects.toThrow(ImportCurrencyMismatchError);
  });

  it("IDOR: another user's account is indistinguishable from a nonexistent one, before any rate is resolved", async () => {
    let rateConsulted = false;
    const spyingSource: ImportRateSource = {
      ...fixedRateSource,
      listRatePoints: async () => {
        rateConsulted = true;
        return [{ day: "2020-01-01", micros: 90_000 }];
      },
    };
    await expect(
      importTransactions(userB.id, {
        bankAccountId: tryAccountA.id,
        adapterId: "generic",
        rateSource: spyingSource,
        rows: [row({ nativeAmount: -100, dedupeKeySource: "idor" })],
      }),
    ).rejects.toThrow(BankAccountNotFoundError);
    expect(rateConsulted).toBe(false);
  });
  it("freezes each row at its own day's rate, exactly, the stored rate reproducing the stored agorot (AGENTS.md §3www)", async () => {
    const twoDaySource: ImportRateSource = {
      listRatePoints: async () => [
        { day: "2026-04-03", micros: 85_123 }, // Friday
        { day: "2026-04-06", micros: 92_876 }, // Monday
      ],
      syncRateHistory: async () => undefined,
    };
    const summary = await importTransactions(userA.id, {
      bankAccountId: tryAccountA.id,
      adapterId: "turkish-signed-amount",
      rateSource: twoDaySource,
      rows: [
        row({ nativeAmount: -100_000, dedupeKeySource: "day-fri", occurredAt: new Date("2026-04-03T00:00:00.000Z") }),
        row({ nativeAmount: -100_000, dedupeKeySource: "day-sun", occurredAt: new Date("2026-04-05T00:00:00.000Z") }),
        row({ nativeAmount: -100_000, dedupeKeySource: "day-mon", occurredAt: new Date("2026-04-06T00:00:00.000Z") }),
      ],
    });
    expect(summary.importedCount).toBe(3);
    const stored = await admin.notableTransaction.findMany({ where: { id: { in: summary.importedIds } }, orderBy: { occurredAt: "asc" } });
    expect(stored.map((t) => t.exchangeRateAtEntry?.toFixed(6))).toEqual(["0.085123", "0.085123", "0.092876"]);
    // -1,000.00 TRY × 0.085123 = -85.123 ILS → -8512; × 0.092876 → -9288.
    expect(stored.map((t) => t.amount)).toEqual([-8512n, -8512n, -9288n]);
  });
});
