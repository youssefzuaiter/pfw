import "server-only";
import { randomUUID } from "node:crypto";
import { createAdminClient } from "../db/admin-client";

/**
 * Permanent account deletion (AGENTS.md §3ttt).
 *
 * Everything a user owns hangs off their `User` row with ON DELETE CASCADE
 * (tests/guards/user-data-cascades.test.ts keeps it that way), so deleting
 * that one row removes all of it, including tables added after this file was
 * written. The work here is making that single delete safe:
 *
 * 1. Lock the user row, so nothing new is written for them mid-deletion.
 * 2. Refuse if ANOTHER user's row points at one of this user's rows (a
 *    transaction on this user's category or bank account, say). The app
 *    never creates such a reference, but no database constraint forbids it,
 *    and the cascade would otherwise delete the other user's row too. A
 *    refusal rolls back everything.
 * 3. Record the deleted id (AccountDeletionRecord), so a restore from an
 *    older backup can be followed by deleting the account again.
 * 4. Set `pfw.purge_user_id` for this transaction only. The append-only
 *    triggers on AuditLog and LedgerCommit allow a DELETE only when this
 *    names the row's owner AND that owner's User row is already gone, i.e.
 *    only as part of this cascade (migration 20261014150000).
 * 5. Delete the User row; the cascade does the rest.
 * 6. Delete the user's rate-limit windows, whose keys embed their id or
 *    email and have no foreign key to cascade from.
 *
 * All six steps are one transaction: either the account is gone completely
 * or nothing changed.
 *
 * Sessions need no separate revocation. They are JWTs, and the jwt()
 * callback looks the user's tokenVersion up on every request; with the row
 * gone it finds none, which clears the session (src/server/auth/auth.ts).
 *
 * Encryption: every server-encrypted column uses the one app-wide key, so
 * there is no per-user key to destroy. Deleting the rows is the erasure.
 * Copies remain in the encrypted nightly backups and the database provider's
 * restore window until those expire; the delete-account screen says so.
 *
 * An admin-client exception (allowlisted in
 * tests/guards/admin-client-boundary.test.ts): no scoped role may delete
 * from the append-only tables, and the cross-tenant check has to see other
 * users' rows.
 */

export type DeleteAccountResult =
  | { ok: true }
  | { ok: false; error: "not_found" }
  | { ok: false; error: "cross_tenant_reference"; references: string[] };

class CrossTenantReferenceError extends Error {
  constructor(readonly references: string[]) {
    super("Another user's rows reference this account's data");
  }
}

type ReferenceCount = { ref: string; count: bigint };

/**
 * Every foreign key from a user-owned table to ANOTHER user-owned table
 * (both have a userId column), except the household tables, whose
 * cross-user rows are expected and removed or unshared by design.
 * tests/integration/account-deletion.test.ts checks this list against the
 * database's own constraints, so a new foreign key cannot be missed.
 */
export const CROSS_TENANT_FOREIGN_KEYS = [
  "Beneficiary.deadMansSwitchId",
  "EmergencyDocument.deadMansSwitchId",
  "RecoveryShareSubmission.deadMansSwitchId",
  "RecoveryShareSubmission.beneficiaryId",
  "NotableTransaction.bankAccountId",
  "NotableTransaction.categoryId",
  "EnvelopeAllocation.categoryId",
  "GoalContribution.goalId",
  "DebtPayment.debtId",
  "HoldingLot.holdingId",
  "Trade.portfolioHoldingId",
  "MerchantEmbedding.categoryId",
  "Dividend.portfolioHoldingId",
  "LedgerCommit.transactionId",
  "BankConnection.bankAccountId",
  "TransactionSplit.transactionId",
  "TransactionSplit.categoryId",
  "RecurringBill.categoryId",
] as const;

export async function deleteAccount(userId: string): Promise<DeleteAccountResult> {
  const admin = createAdminClient();
  try {
    await admin.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<{ id: string; email: string }[]>`
          SELECT "id", "email" FROM "User" WHERE "id" = ${userId} FOR UPDATE
        `;
        if (locked.length === 0) throw new NotFoundError();
        const { email } = locked[0];

        const references = await tx.$queryRaw<ReferenceCount[]>`
          SELECT 'Beneficiary.deadMansSwitchId' AS ref, count(*)::bigint AS count FROM "Beneficiary" c JOIN "DeadMansSwitch" p ON p."id" = c."deadMansSwitchId" WHERE p."userId" = ${userId} AND c."userId" <> ${userId}
          UNION ALL SELECT 'EmergencyDocument.deadMansSwitchId', count(*) FROM "EmergencyDocument" c JOIN "DeadMansSwitch" p ON p."id" = c."deadMansSwitchId" WHERE p."userId" = ${userId} AND c."userId" <> ${userId}
          UNION ALL SELECT 'RecoveryShareSubmission.deadMansSwitchId', count(*) FROM "RecoveryShareSubmission" c JOIN "DeadMansSwitch" p ON p."id" = c."deadMansSwitchId" WHERE p."userId" = ${userId} AND c."userId" <> ${userId}
          UNION ALL SELECT 'RecoveryShareSubmission.beneficiaryId', count(*) FROM "RecoveryShareSubmission" c JOIN "Beneficiary" p ON p."id" = c."beneficiaryId" WHERE p."userId" = ${userId} AND c."userId" <> ${userId}
          UNION ALL SELECT 'NotableTransaction.bankAccountId', count(*) FROM "NotableTransaction" c JOIN "BankAccount" p ON p."id" = c."bankAccountId" WHERE p."userId" = ${userId} AND c."userId" <> ${userId}
          UNION ALL SELECT 'NotableTransaction.categoryId', count(*) FROM "NotableTransaction" c JOIN "Category" p ON p."id" = c."categoryId" WHERE p."userId" = ${userId} AND c."userId" <> ${userId}
          UNION ALL SELECT 'EnvelopeAllocation.categoryId', count(*) FROM "EnvelopeAllocation" c JOIN "Category" p ON p."id" = c."categoryId" WHERE p."userId" = ${userId} AND c."userId" <> ${userId}
          UNION ALL SELECT 'GoalContribution.goalId', count(*) FROM "GoalContribution" c JOIN "Goal" p ON p."id" = c."goalId" WHERE p."userId" = ${userId} AND c."userId" <> ${userId}
          UNION ALL SELECT 'DebtPayment.debtId', count(*) FROM "DebtPayment" c JOIN "Debt" p ON p."id" = c."debtId" WHERE p."userId" = ${userId} AND c."userId" <> ${userId}
          UNION ALL SELECT 'HoldingLot.holdingId', count(*) FROM "HoldingLot" c JOIN "PortfolioHolding" p ON p."id" = c."holdingId" WHERE p."userId" = ${userId} AND c."userId" <> ${userId}
          UNION ALL SELECT 'Trade.portfolioHoldingId', count(*) FROM "Trade" c JOIN "PortfolioHolding" p ON p."id" = c."portfolioHoldingId" WHERE p."userId" = ${userId} AND c."userId" <> ${userId}
          UNION ALL SELECT 'MerchantEmbedding.categoryId', count(*) FROM "MerchantEmbedding" c JOIN "Category" p ON p."id" = c."categoryId" WHERE p."userId" = ${userId} AND c."userId" <> ${userId}
          UNION ALL SELECT 'Dividend.portfolioHoldingId', count(*) FROM "Dividend" c JOIN "PortfolioHolding" p ON p."id" = c."portfolioHoldingId" WHERE p."userId" = ${userId} AND c."userId" <> ${userId}
          UNION ALL SELECT 'LedgerCommit.transactionId', count(*) FROM "LedgerCommit" c JOIN "NotableTransaction" p ON p."id" = c."transactionId" WHERE p."userId" = ${userId} AND c."userId" <> ${userId}
          UNION ALL SELECT 'BankConnection.bankAccountId', count(*) FROM "BankConnection" c JOIN "BankAccount" p ON p."id" = c."bankAccountId" WHERE p."userId" = ${userId} AND c."userId" <> ${userId}
        `;
        const found = references.filter((row) => row.count > 0n).map((row) => row.ref);
        if (found.length > 0) throw new CrossTenantReferenceError(found);

        await tx.$executeRaw`
          INSERT INTO "AccountDeletionRecord" ("id", "deletedUserId") VALUES (${randomUUID()}, ${userId})
          ON CONFLICT ("deletedUserId") DO NOTHING
        `;
        await tx.$queryRaw`SELECT set_config('pfw.purge_user_id', ${userId}, true)`;
        await tx.$executeRaw`DELETE FROM "User" WHERE "id" = ${userId}`;

        // Keys are `<route>:<userId>` or `auth:<action>:<email>`. A cuid
        // holds no LIKE wildcard; the email keys are matched exactly.
        const normalizedEmail = email.trim().toLowerCase();
        const emailKeys = ["login", "register", "forgot-password"].flatMap((action) =>
          [...new Set([email, normalizedEmail])].map((value) => `auth:${action}:${value}`),
        );
        await tx.$executeRaw`
          DELETE FROM "RateLimitBucket" WHERE "key" LIKE ${`%:${userId}`} OR "key" = ANY(${emailKeys})
        `;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    return { ok: true };
  } catch (error) {
    if (error instanceof NotFoundError) return { ok: false, error: "not_found" };
    if (error instanceof CrossTenantReferenceError) return { ok: false, error: "cross_tenant_reference", references: error.references };
    throw error;
  } finally {
    await admin.$disconnect();
  }
}

class NotFoundError extends Error {}
