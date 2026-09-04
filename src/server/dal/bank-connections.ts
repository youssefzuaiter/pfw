import "server-only";
import { withUserScope } from "../db/with-user-scope";
import { findMockInstitution, MOCK_INSTITUTIONS, UnknownInstitutionError, type Psd2ConnectResult } from "../../lib/banking/psd2-client";

/**
 * EU Open Banking PSD2 Ingestion (ad hoc) — connection management
 * (list/link/unlink). The actual sync (fetching and ingesting
 * transactions) lives in `src/server/banking/sync-service.ts` instead —
 * this module is pure CRUD over `BankConnection`/`BankAccount`, no
 * categorization or currency-conversion concerns.
 */

export type BankConnectionSummary = {
  id: string;
  institutionId: string;
  institutionName: string;
  bankAccountId: string;
  status: string;
  expiresAt: Date;
  lastSyncedAt: Date | null;
  createdAt: Date;
};

export async function listBankConnections(userId: string): Promise<BankConnectionSummary[]> {
  const rows = await withUserScope(userId, (tx) =>
    tx.bankConnection.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
  );
  return rows.map((row) => ({
    id: row.id,
    institutionId: row.institutionId,
    institutionName: findMockInstitution(row.institutionId)?.name ?? row.institutionId,
    bankAccountId: row.bankAccountId,
    status: row.status,
    expiresAt: row.expiresAt,
    lastSyncedAt: row.lastSyncedAt,
    createdAt: row.createdAt,
  }));
}

/**
 * Links a new (mock) institution: completes the mock consent flow
 * (`connectToInstitution`), then creates BOTH the `BankAccount` the
 * connection will sync transactions into AND the `BankConnection` row
 * itself, in the SAME transaction — a connection with no account to
 * attach transactions to (or an account with no connection tracking its
 * token/expiry) would each be a genuinely broken half-state, so both are
 * created together or neither is.
 */
export async function linkBankConnection(userId: string, institutionId: string, result: Psd2ConnectResult): Promise<BankConnectionSummary> {
  const institution = findMockInstitution(institutionId);
  if (!institution) throw new UnknownInstitutionError(institutionId);

  return withUserScope(userId, async (tx) => {
    const bankAccount = await tx.bankAccount.create({
      data: {
        userId,
        institutionName: institution.name,
        // The mock IBAN's last 4 characters, matching this app's existing "last 4, never a full account number" law (§2.1) — applied here even though the whole IBAN is itself mock data, since this feature's own code should never model handling a real account identifier more casually than production code should.
        last4: result.account.iban.slice(-4),
        accountType: "CHECKING",
        currency: institution.currency,
        nativeBalance: 0n,
      },
    });

    const connection = await tx.bankConnection.create({
      data: {
        userId,
        institutionId,
        bankAccountId: bankAccount.id,
        accessToken: result.accessToken,
        expiresAt: result.expiresAt,
        status: "ACTIVE",
      },
    });

    return {
      id: connection.id,
      institutionId: connection.institutionId,
      institutionName: institution.name,
      bankAccountId: bankAccount.id,
      status: connection.status,
      expiresAt: connection.expiresAt,
      lastSyncedAt: connection.lastSyncedAt,
      createdAt: connection.createdAt,
    };
  });
}

/**
 * Unlinks a connection — deletes only the `BankConnection` row, NEVER
 * the `BankAccount` it pointed at (no cascade in that direction). Real
 * "disconnect my bank" UX everywhere keeps already-imported transaction
 * history intact; only future syncing stops. Returns `false` for both
 * "doesn't exist" and "belongs to someone else" (Section 2.2's IDOR
 * shape).
 */
export async function unlinkBankConnection(userId: string, connectionId: string): Promise<boolean> {
  const result = await withUserScope(userId, (tx) => tx.bankConnection.deleteMany({ where: { id: connectionId, userId } }));
  return result.count > 0;
}

export async function getBankConnectionForSync(userId: string, connectionId: string) {
  return withUserScope(userId, (tx) => tx.bankConnection.findFirst({ where: { id: connectionId, userId } }));
}

export function listAvailableInstitutions() {
  return MOCK_INSTITUTIONS;
}
