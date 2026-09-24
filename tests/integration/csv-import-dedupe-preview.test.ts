import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import { countAlreadyImported } from "../../src/server/dal/transaction-import";
import type { CanonicalImportRow } from "../../src/lib/csv-import/types";
import { deleteTestUsersWithLedgerCommits } from "./ledger-commit-test-helpers";

/**
 * The preview must be able to say what is ALREADY in the ledger.
 *
 * Dedupe itself has always held, but the dry run only parsed the file —
 * so after a real 211-row import it still read "211 rows ready", exactly
 * as it had the first time, leaving the user to trust an irreversible
 * button with no evidence.
 */
const hasDb = Boolean(process.env.APP_DATABASE_URL && process.env.DATABASE_URL);

describe.skipIf(!hasDb)("countAlreadyImported", () => {
  const admin = createAdminClient();
  const email = `dedupe-preview-${Date.now()}@example.com`;
  let userId = "";
  let bankAccountId = "";
  let categoryId = "";

  const row = (lineNumber: number, amount: number): CanonicalImportRow => ({
    lineNumber,
    occurredAt: new Date("2026-08-01T00:00:00.000Z"),
    nativeAmount: amount as CanonicalImportRow["nativeAmount"],
    currency: "TRY",
    description: `Kart İşlemleri ${lineNumber}`,
    merchantName: null,
    providerReference: null,
    dedupeKeySource: `2026-08-01|${amount}|kart-islemleri-${lineNumber}|0`,
  });

  beforeAll(async () => {
    const user = await admin.user.create({ data: { email, displayName: "Dedupe Preview" } });
    userId = user.id;
    const account = await admin.bankAccount.create({
      data: { userId, institutionName: "QNB", last4: "9669", accountType: "CHECKING", currency: "TRY", nativeBalance: 0n },
    });
    bankAccountId = account.id;
    const category = await admin.category.create({
      data: { userId, name: "Uncategorized", slug: `uncategorized-${Date.now()}`, isUncategorized: true },
    });
    categoryId = category.id;
  });

  afterAll(async () => {
    await deleteTestUsersWithLedgerCommits(admin, [userId]);
    await admin.$disconnect();
  });

  it("counts nothing before anything is imported, and every row after", async () => {
    const rows = [row(1, -9425), row(2, 23025)];

    expect(await countAlreadyImported(userId, rows, "turkish-signed-amount")).toBe(0);

    // Write the rows exactly as the importer keys them.
    const { buildProviderTransactionId } = await import("../../src/server/dal/transaction-import");
    for (const r of rows) {
      await admin.notableTransaction.create({
        data: {
          user: { connect: { id: userId } },
          bankAccount: { connect: { id: bankAccountId } },
          category: { connect: { id: categoryId } },
          occurredAt: r.occurredAt,
          amount: BigInt(r.nativeAmount),
          nativeAmount: BigInt(r.nativeAmount),
          currency: "TRY",
          description: r.description,
          providerTransactionId: buildProviderTransactionId(r, "turkish-signed-amount"),
        },
      });
    }

    expect(await countAlreadyImported(userId, rows, "turkish-signed-amount")).toBe(2);
    // A row this user has never seen is still counted as new.
    expect(await countAlreadyImported(userId, [...rows, row(3, -797)], "turkish-signed-amount")).toBe(2);
  });
});
