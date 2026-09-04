import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import { linkBankConnection, listBankConnections, unlinkBankConnection } from "../../src/server/dal/bank-connections";
import { syncBankConnection } from "../../src/server/banking/sync-service";
import { connectToInstitution, MOCK_INSTITUTIONS, Psd2ApiError } from "../../src/lib/banking/psd2-client";

/**
 * Integration coverage for EU Open Banking PSD2 Ingestion (ad hoc) —
 * against real Postgres with RLS active, exercising the REAL, unmodified
 * mock PSD2 client (including its real ~8% simulated failure rate, per
 * this feature's own explicit "realistic latency/failures" ask) rather
 * than stubbing it out. `withRetryOnSimulatedFailure` is what makes that
 * safe to do in a test suite: it retries exactly the way a real user
 * clicking "Sync now" again would, so an occasional simulated failure
 * doesn't make this suite flaky while still running against completely
 * real, unmocked production code.
 */
function withRetryOnSimulatedFailure<T>(fn: () => Promise<T>, maxAttempts = 8): Promise<T> {
  async function attempt(remaining: number): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof Psd2ApiError && remaining > 1) return attempt(remaining - 1);
      throw error;
    }
  }
  return attempt(maxAttempts);
}

describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("EU Open Banking PSD2 Ingestion", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let userA: { id: string };
  let userB: { id: string };

  beforeAll(async () => {
    admin = createAdminClient();
    userA = await admin.user.create({
      data: { email: `psd2-test-a-${Date.now()}@pfw.local`, displayName: "PSD2 Test A" },
    });
    userB = await admin.user.create({
      data: { email: `psd2-test-b-${Date.now()}@pfw.local`, displayName: "PSD2 Test B" },
    });
    for (const user of [userA, userB]) {
      await admin.category.create({ data: { userId: user.id, slug: "uncategorized", name: "Uncategorized", isUncategorized: true } });
    }
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
    await admin.$disconnect();
  });

  it("linking a connection creates both a BankAccount (in the institution's currency) and a BankConnection", async () => {
    const institution = MOCK_INSTITUTIONS[0];
    const connectResult = await withRetryOnSimulatedFailure(() => connectToInstitution(institution.id));
    const connection = await linkBankConnection(userA.id, institution.id, connectResult);

    expect(connection.institutionId).toBe(institution.id);
    expect(connection.status).toBe("ACTIVE");

    const bankAccount = await admin.bankAccount.findUniqueOrThrow({ where: { id: connection.bankAccountId } });
    expect(bankAccount.currency).toBe(institution.currency);
    expect(bankAccount.userId).toBe(userA.id);
  });

  it("syncing a fresh connection pulls in the full mock history, converted to ILS agorot with a frozen exchange rate", async () => {
    const institution = MOCK_INSTITUTIONS[1];
    const connectResult = await withRetryOnSimulatedFailure(() => connectToInstitution(institution.id));
    const connection = await linkBankConnection(userA.id, institution.id, connectResult);

    const result = await withRetryOnSimulatedFailure(async () => {
      const r = await syncBankConnection(userA.id, connection.id);
      if (!r.ok) throw new Psd2ApiError("SERVICE_UNAVAILABLE", "retry");
      return r;
    });

    expect(result.importedCount).toBeGreaterThan(0);
    expect(result.duplicateCount).toBe(0);

    const transactions = await admin.notableTransaction.findMany({ where: { bankAccountId: connection.bankAccountId } });
    expect(transactions.length).toBe(result.importedCount);
    for (const transaction of transactions) {
      expect(transaction.currency).toBe(institution.currency);
      expect(transaction.amount).toBeLessThan(0n); // the mock only generates expenses
      expect(transaction.nativeAmount).toBeLessThan(0n);
      expect(transaction.exchangeRateAtEntry).not.toBeNull();
      expect(transaction.providerTransactionId?.startsWith(`psd2:${institution.id}:`)).toBe(true);
    }
  });

  it("re-fetching the exact same window reports every row as a duplicate, not a re-insert — the actual point of the dedupe mechanism", async () => {
    const institution = MOCK_INSTITUTIONS[2];
    const connectResult = await withRetryOnSimulatedFailure(() => connectToInstitution(institution.id));
    const connection = await linkBankConnection(userA.id, institution.id, connectResult);

    const first = await withRetryOnSimulatedFailure(async () => {
      const r = await syncBankConnection(userA.id, connection.id);
      if (!r.ok) throw new Psd2ApiError("SERVICE_UNAVAILABLE", "retry");
      return r;
    });
    expect(first.importedCount).toBeGreaterThan(0);

    // Force the SAME full window to be re-fetched (rather than relying on
    // "today happens to have zero new transactions", which would make
    // this assertion vacuously true instead of actually proving dedup) —
    // resets `lastSyncedAt` back to null via the admin client, simulating
    // "re-sync the entire history again," the strongest real test of the
    // dedupe guarantee: the mock client's own history for this
    // institution is deterministic (psd2-client.ts's own doc comment),
    // so this second sync sees the EXACT same transaction set the first
    // one did.
    await admin.bankConnection.update({ where: { id: connection.id }, data: { lastSyncedAt: null } });

    const second = await withRetryOnSimulatedFailure(async () => {
      const r = await syncBankConnection(userA.id, connection.id);
      if (!r.ok) throw new Psd2ApiError("SERVICE_UNAVAILABLE", "retry");
      return r;
    });
    expect(second.importedCount).toBe(0);
    expect(second.duplicateCount).toBe(first.importedCount);

    const totalRows = await admin.notableTransaction.count({ where: { bankAccountId: connection.bankAccountId } });
    expect(totalRows).toBe(first.importedCount);
  });

  it("returns connection_not_found for another user's connection (IDOR)", async () => {
    const institution = MOCK_INSTITUTIONS[3];
    const connectResult = await withRetryOnSimulatedFailure(() => connectToInstitution(institution.id));
    const connection = await linkBankConnection(userA.id, institution.id, connectResult);

    const result = await syncBankConnection(userB.id, connection.id);
    expect(result).toEqual({ ok: false, error: "connection_not_found" });
  });

  it("unlinking removes the BankConnection but leaves the BankAccount and its already-synced transactions intact", async () => {
    const institution = MOCK_INSTITUTIONS[4];
    const connectResult = await withRetryOnSimulatedFailure(() => connectToInstitution(institution.id));
    const connection = await linkBankConnection(userA.id, institution.id, connectResult);
    await withRetryOnSimulatedFailure(async () => {
      const r = await syncBankConnection(userA.id, connection.id);
      if (!r.ok) throw new Psd2ApiError("SERVICE_UNAVAILABLE", "retry");
      return r;
    });

    const transactionCountBefore = await admin.notableTransaction.count({ where: { bankAccountId: connection.bankAccountId } });
    expect(transactionCountBefore).toBeGreaterThan(0);

    const unlinkedByB = await unlinkBankConnection(userB.id, connection.id);
    expect(unlinkedByB).toBe(false); // IDOR

    const unlinkedByA = await unlinkBankConnection(userA.id, connection.id);
    expect(unlinkedByA).toBe(true);

    const remainingConnections = await listBankConnections(userA.id);
    expect(remainingConnections.find((c) => c.id === connection.id)).toBeUndefined();

    const bankAccountStillThere = await admin.bankAccount.findUnique({ where: { id: connection.bankAccountId } });
    expect(bankAccountStillThere).not.toBeNull();
    const transactionCountAfter = await admin.notableTransaction.count({ where: { bankAccountId: connection.bankAccountId } });
    expect(transactionCountAfter).toBe(transactionCountBefore);
  });
});
