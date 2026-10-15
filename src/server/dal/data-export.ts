import "server-only";
import { withUserScope } from "../db/with-user-scope";
import { decryptField } from "../crypto/field-encryption";
import {
  EXPORT_TABLES,
  REDACTED_HOUSEHOLD,
  REDACTED_PERSON,
  redactOtherPeople,
  toExportRow,
  toExportValue,
  type ExportRow,
  type ExportTableName,
} from "../../lib/data-export/format";

/**
 * Everything one user owns, decrypted, as plain rows (AGENTS.md §3uuu).
 *
 * Tenant isolation, twice over:
 * - Every query names the user explicitly (`where: { userId }`, or
 *   `createdById` / `id` for the three tables keyed differently). RLS alone
 *   is NOT enough here: the household policies deliberately let a member
 *   read a housemate's shared categories, accounts, envelopes, the
 *   household itself and the housemate's User row. A query that leaned on
 *   RLS would export them.
 * - The queries still run inside `withUserScope`, so RLS remains the second
 *   wall: nothing outside the user's own scope is even readable.
 *
 * No query includes a relation. Field encryption decrypts only top-level
 * reads of its own model (a nested `include` comes back as ciphertext), and
 * a join is exactly where another user's row could slip in. Each table is
 * read flat, columns are chosen with `omit`, and the five server-encrypted
 * columns arrive decrypted by the extension.
 *
 * Nothing touches disk: rows go from the database into memory and out in the
 * response.
 */

export type UserExport = {
  account: ExportRow;
  tables: Record<ExportTableName, ExportRow[]>;
};

const EXPORT_TIMEOUT_MS = 30_000;

export async function gatherUserExport(userId: string): Promise<UserExport | null> {
  return withUserScope(
    userId,
    async (tx) => {
      const user = await tx.user.findFirst({
        where: { id: userId },
        omit: { passwordHash: true, totpSecret: true, totpLastUsedTimeStep: true, tokenVersion: true, failedLoginAttempts: true, accountLockedAt: true },
      });
      if (!user) return null;
      const self = { id: user.id, email: user.email };
      const byId = { orderBy: { id: "asc" as const } };

      const raw: Record<ExportTableName, Record<string, unknown>[]> = {
        bankAccounts: await tx.bankAccount.findMany({ where: { userId }, ...byId }),
        bankConnections: await tx.bankConnection.findMany({ where: { userId }, omit: { accessToken: true }, ...byId }),
        categories: await tx.category.findMany({ where: { userId }, ...byId }),
        transactions: await tx.notableTransaction.findMany({ where: { userId }, ...byId }),
        transactionSplits: await tx.transactionSplit.findMany({ where: { userId }, ...byId }),
        transactionRules: await tx.transactionRule.findMany({ where: { userId }, ...byId }),
        envelopeAllocations: await tx.envelopeAllocation.findMany({ where: { userId }, ...byId }),
        goals: await tx.goal.findMany({ where: { userId }, ...byId }),
        goalContributions: (await tx.goalContribution.findMany({ where: { userId }, ...byId })).map((row) => ({
          ...row,
          note: readableNote(row.note),
        })),
        debts: await tx.debt.findMany({ where: { userId }, ...byId }),
        debtPayments: await tx.debtPayment.findMany({ where: { userId }, ...byId }),
        manualAssets: await tx.manualAsset.findMany({ where: { userId }, ...byId }),
        cryptoWallets: await tx.cryptoWallet.findMany({ where: { userId }, ...byId }),
        portfolioHoldings: await tx.portfolioHolding.findMany({ where: { userId }, ...byId }),
        holdingLots: await tx.holdingLot.findMany({ where: { userId }, ...byId }),
        trades: await tx.trade.findMany({ where: { userId }, ...byId }),
        dividends: await tx.dividend.findMany({ where: { userId }, ...byId }),
        scenarioMetrics: await tx.scenarioMetrics.findMany({ where: { userId }, ...byId }),
        coreJournalEntries: await tx.coreJournalEntry.findMany({ where: { userId }, ...byId }),
        coreSnapshots: await tx.coreSnapshot.findMany({ where: { userId }, ...byId }),
        coreRouterStatus: await tx.coreRouterStatus.findMany({ where: { userId }, ...byId }),
        netWorthSnapshots: await tx.netWorthSnapshot.findMany({ where: { userId }, ...byId }),
        subscriptionTracking: await tx.subscriptionTracking.findMany({ where: { userId }, ...byId }),
        merchantEmbeddings: await tx.merchantEmbedding.findMany({ where: { userId }, omit: { embedding: true }, ...byId }),
        settings: await tx.userSettings.findMany({ where: { userId }, ...byId }),
        phoneAlertSubscription: await tx.phoneAlertSubscription.findMany({ where: { userId }, omit: { topic: true }, ...byId }),
        notifications: await tx.notification.findMany({ where: { userId }, ...byId }),
        passkeys: await tx.authenticator.findMany({ where: { userId }, omit: { credentialId: true, publicKey: true, counter: true }, ...byId }),
        deadMansSwitch: await tx.deadMansSwitch.findMany({ where: { userId }, ...byId }),
        beneficiaries: await tx.beneficiary.findMany({ where: { userId }, omit: { shareHash: true, inviteTokenHash: true }, ...byId }),
        emergencyDocuments: await tx.emergencyDocument.findMany({ where: { userId }, ...byId }),
        householdsCreated: await tx.sharedGroup.findMany({ where: { createdById: userId }, ...byId }),
        householdMemberships: await tx.groupMember.findMany({ where: { userId }, ...byId }),
        householdInvitesSent: await tx.groupInvite.findMany({ where: { createdById: userId }, omit: { tokenHash: true, acceptedById: true }, ...byId }),
        auditLog: await tx.auditLog.findMany({ where: { userId }, ...byId }),
        ledgerCommits: await tx.ledgerCommit.findMany({ where: { userId }, ...byId }),
      };

      const ownedHouseholds = new Set(raw.householdsCreated.map((group) => String(group.id)));
      const context = { self, ownedHouseholds };
      const tables = Object.fromEntries(
        EXPORT_TABLES.map((name) => [name, raw[name].map((record) => cleanRow(name, toExportRow(record), context))]),
      ) as Record<ExportTableName, ExportRow[]>;

      return { account: toExportRow(user), tables };
    },
    { timeoutMs: EXPORT_TIMEOUT_MS },
  );
}

/**
 * A goal note is browser-encrypted (`zk1:`, exported as stored) or, from
 * before that existed, server-encrypted (`v1:`/`v2:`), which the server can
 * and does decrypt here. A value it cannot decrypt is exported as stored
 * rather than failing the whole export.
 */
function readableNote(note: string | null): string | null {
  if (note === null || !/^v[12]:/.test(note)) return note;
  try {
    return decryptField(note);
  } catch {
    return note;
  }
}

type CleanContext = { self: { id: string; email: string }; ownedHouseholds: Set<string> };

/**
 * Removes other people's identifiers from the user's own rows: user ids and
 * emails (see redactOtherPeople), and the id of a household someone else
 * owns — which the user's own membership, and anything they shared into it,
 * points at.
 */
function cleanRow(table: ExportTableName, input: ExportRow, { self, ownedHouseholds }: CleanContext): ExportRow {
  let row = input;
  if (typeof row.sharedGroupId === "string" && !ownedHouseholds.has(row.sharedGroupId)) {
    row = { ...row, sharedGroupId: REDACTED_HOUSEHOLD };
  }
  if (table === "householdInvitesSent") return redactOtherPeople(row, self) as ExportRow;
  if (table !== "auditLog") return row;
  // A household owner's member actions record the member's user id as the
  // entity itself.
  const entityId = row.entityType === "GroupMember" && row.entityId !== self.id ? REDACTED_PERSON : row.entityId;
  return {
    ...row,
    entityId: toExportValue(entityId),
    beforeData: redactOtherPeople(row.beforeData ?? null, self),
    afterData: redactOtherPeople(row.afterData ?? null, self),
  };
}
