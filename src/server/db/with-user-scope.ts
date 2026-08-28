import "server-only";
import { prisma } from "./client";

/**
 * The interactive-transaction client type, inferred structurally from the
 * actual (encryption-extended) `prisma` instance rather than the
 * generated `Prisma.TransactionClient` alias — that alias is hardcoded to
 * the *unextended* base client's generic parameters, which doesn't
 * structurally match a client built with `$extends` (see the type error
 * this replaced: a real, verified mismatch, not a style preference).
 */
type ScopedTransactionClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Wraps a DB operation in a transaction that first sets the Postgres
 * session variable every Row-Level Security policy is keyed on
 * (`app.current_user_id`), then runs `run` against that same transaction.
 *
 * This is the RLS half of the "belt and suspenders" scoping story — the
 * DAL's own `where: { userId }` clauses are the primary control (Section
 * 2.2 of the spec); this makes a forgotten or buggy `where` clause fail
 * closed at the database level instead of leaking another user's row.
 *
 * `set_config(..., true)` scopes the setting to the current transaction
 * only (the `true` third argument is `is_local`) — it never leaks across
 * connections in the pool, and the parameter is bound, not
 * string-interpolated, so it can't be used for SQL injection even though
 * `SET` itself doesn't support bind parameters directly.
 */
export type UserScopeOptions = {
  /**
   * Overrides Prisma's default 5-second interactive-transaction timeout.
   * Needed only by genuinely bulk operations — the CSV statement import
   * writes rows one at a time (it must: `notableTransaction.createMany`
   * throws inside the field-encryption extension, deliberately, since a
   * batch write would otherwise persist `description` as plaintext), and
   * a few thousand of those legitimately exceed 5s. Every ordinary
   * single-row DAL call leaves this unset.
   */
  timeoutMs?: number;
};

export async function withUserScope<T>(
  userId: string,
  run: (tx: ScopedTransactionClient) => Promise<T>,
  options: UserScopeOptions = {},
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
      return run(tx);
    },
    options.timeoutMs === undefined ? undefined : { timeout: options.timeoutMs, maxWait: options.timeoutMs },
  );
}
