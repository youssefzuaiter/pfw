import type { createAdminClient } from "../../src/server/db/admin-client";

/**
 * Deletes test users by id, temporarily disabling `LedgerCommit`'s
 * append-only trigger around the delete — same established pattern
 * `prisma/seed/index.ts` already uses for `AuditLog`'s identical
 * trigger. Necessary because `LedgerCommit` now cascade-deletes with its
 * owning `User` (Cryptographic Ledger Versioning, ad hoc): a cascading
 * DELETE still fires the child table's own `BEFORE DELETE` trigger, so
 * any test whose users have real ledger commits (i.e. called
 * `createTransaction`/`updateTransactionCategory`, not just seeded
 * `NotableTransaction` rows directly — the seed script itself never
 * creates `LedgerCommit` rows, since it writes transactions directly via
 * `prisma.notableTransaction.create`, bypassing the DAL entirely) needs
 * this instead of a plain `admin.user.deleteMany(...)`.
 *
 * Wrapped in ONE Prisma interactive transaction, not three separate
 * top-level calls — a real bug the first version of this helper hit:
 * `ALTER TABLE ... DISABLE/ENABLE TRIGGER` is global database state, not
 * connection- or transaction-local, and Vitest runs integration test
 * files in parallel (separate worker processes) — one file's ENABLE
 * could land between another file's DISABLE and DELETE, reproduced live
 * as an intermittent "append-only" failure on a delete that had
 * genuinely already disabled the trigger moments earlier. `ALTER TABLE`
 * takes Postgres's own ACCESS EXCLUSIVE lock on the table, held for the
 * transaction's duration — wrapping DISABLE+DELETE+ENABLE in one
 * transaction means a concurrent caller's own ALTER TABLE simply BLOCKS
 * until this transaction commits (at which point the trigger is already
 * correctly re-enabled), which serializes every concurrent caller
 * automatically via ordinary Postgres locking, no application-level
 * advisory lock required. It also means a thrown error rolls back the
 * DISABLE along with everything else — the trigger can never be left
 * disabled by a failed cleanup, unlike the original un-transactional
 * version. A generous 15s transaction timeout accommodates a cleanup
 * that may need to wait its turn behind another concurrent test file's
 * own cleanup, rather than the default 5s.
 */
export async function deleteTestUsersWithLedgerCommits(
  admin: ReturnType<typeof createAdminClient>,
  userIds: readonly string[],
): Promise<void> {
  await admin.$transaction(
    async (tx) => {
      await tx.$executeRaw`ALTER TABLE "LedgerCommit" DISABLE TRIGGER ledger_commit_append_only`;
      await tx.user.deleteMany({ where: { id: { in: [...userIds] } } });
      await tx.$executeRaw`ALTER TABLE "LedgerCommit" ENABLE TRIGGER ledger_commit_append_only`;
    },
    { timeout: 15_000, maxWait: 15_000 },
  );
}
