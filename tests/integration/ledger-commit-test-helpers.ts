import type { createAdminClient } from "../../src/server/db/admin-client";

const MAX_ATTEMPTS = 6;

/** Postgres picked this transaction as the victim of a lock cycle; nothing was committed, so retrying is safe. */
function isDeadlock(error: unknown): boolean {
  return error instanceof Error && /deadlock detected/.test(error.message);
}

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
 *
 * A second race, found when CI failed `mutating-route-sweep` with
 * "deadlock detected": serializing on the two ALTER TABLE locks only works
 * if every caller takes them in the SAME ORDER, and that order is not a free
 * choice. A plain `user.deleteMany` cascades into LedgerCommit and then
 * AuditLog, so this helper must lock them in that order too. Two test files
 * kept inline copies that locked AuditLog first, so run beside this helper or
 * beside any plain delete each side held the lock the other needed. Reproduced
 * on demand with two transactions and a pause between their locks; with the
 * wrong order, a stress run of concurrent cleanups also made plain deletes the
 * victims, which is how the right order was found. Now there is one copy, one
 * order, and a retry for any lock cycle that still occurs: Postgres rolls the
 * victim back completely, so retrying loses nothing.
 */
export async function deleteTestUsersWithLedgerCommits(
  admin: ReturnType<typeof createAdminClient>,
  userIds: readonly string[],
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await admin.$transaction(
        async (tx) => {
          // ALWAYS this order: LedgerCommit, then AuditLog. It is the order a
          // plain `user.deleteMany` takes its cascade locks in, which is what
          // lets the ~30 test files that delete users that way run beside this
          // without a lock cycle. Both triggers are disabled even when a caller
          // only wrote ledger commits, because the delete cascades into
          // AuditLog either way.
          await tx.$executeRaw`ALTER TABLE "LedgerCommit" DISABLE TRIGGER ledger_commit_append_only`;
          await tx.$executeRaw`ALTER TABLE "AuditLog" DISABLE TRIGGER audit_log_append_only`;
          await tx.user.deleteMany({ where: { id: { in: [...userIds] } } });
          await tx.$executeRaw`ALTER TABLE "LedgerCommit" ENABLE TRIGGER ledger_commit_append_only`;
          await tx.$executeRaw`ALTER TABLE "AuditLog" ENABLE TRIGGER audit_log_append_only`;
        },
        { timeout: 30_000, maxWait: 30_000 },
      );
      return;
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !isDeadlock(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 200));
    }
  }
}
