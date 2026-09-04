import "server-only";
import type { LedgerCommitAction, Prisma } from "../../generated/prisma/client";
import { computeLedgerCommitHash, type LedgerCommitState } from "../../lib/ledger-hash";

export type { LedgerCommitState } from "../../lib/ledger-hash";
import { withUserScope, type ScopedTransactionClient } from "../db/with-user-scope";

/**
 * A row shape sufficient to build a `LedgerCommitState` — the subset of
 * `NotableTransaction` (plus its category name) every mutation already
 * has in hand right after a create/update, so this never needs a second
 * query.
 */
export type LedgerableTransaction = {
  id: string;
  categoryId: string;
  categoryName: string;
  amount: bigint;
  currency: string;
  nativeAmount: bigint;
  occurredAt: Date;
  description: string;
  merchantName: string | null;
};

export function buildLedgerState(row: LedgerableTransaction): LedgerCommitState {
  return {
    transactionId: row.id,
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    amountAgorot: row.amount.toString(),
    currency: row.currency,
    nativeAmount: row.nativeAmount.toString(),
    occurredAtIso: row.occurredAt.toISOString(),
    description: row.description,
    merchantName: row.merchantName,
  };
}

/**
 * Appends the next hash-chained commit for one transaction's ledger
 * history — takes the CALLER's own `tx` (a `ScopedTransactionClient`
 * already inside a `withUserScope` transaction), never opens a second
 * one. Atomicity is the entire point: this must succeed or fail together
 * with the `NotableTransaction` create/update it documents, in the same
 * database transaction. This is a deliberate difference from this app's
 * existing `recordAuditLog` (`src/server/dal/audit-log.ts`), which runs
 * as a SEPARATE `withUserScope` transaction, called from the route layer
 * after the DAL mutation has already committed — acceptable for
 * AuditLog's compliance-trail purpose, but exactly the gap a
 * tamper-evidence hash chain can't tolerate: a transaction that
 * committed with no corresponding commit (or vice versa) would silently
 * break the chain's own append-only guarantee.
 *
 * The previous link is read via the SAME `tx`, so it sees this same
 * transaction's own uncommitted writes if called twice in one DB
 * transaction (never happens today — each DAL mutation appends at most
 * one commit — but makes the function correct under that shape too,
 * rather than accidentally relying on read-committed isolation seeing a
 * stale prior row).
 */
export async function appendLedgerCommit(
  tx: ScopedTransactionClient,
  userId: string,
  params: { transactionId: string; action: LedgerCommitAction; state: LedgerCommitState },
): Promise<void> {
  const previous = await tx.ledgerCommit.findFirst({
    where: { userId, transactionId: params.transactionId },
    orderBy: { createdAt: "desc" },
  });

  const previousHash = previous?.currentHash ?? null;
  const currentHash = computeLedgerCommitHash(previousHash, params.state);

  await tx.ledgerCommit.create({
    data: {
      userId,
      transactionId: params.transactionId,
      action: params.action,
      previousHash,
      currentHash,
      patchData: params.state as unknown as Prisma.InputJsonValue,
    },
  });
}

export type LedgerCommitView = {
  id: string;
  action: LedgerCommitAction;
  previousHash: string | null;
  currentHash: string;
  patchData: LedgerCommitState;
  createdAt: Date;
};

/** Oldest-first — the natural reading order for a chain and for a timeline UI. */
export async function getLedgerHistory(userId: string, transactionId: string): Promise<LedgerCommitView[]> {
  const rows = await withUserScope(userId, (tx) =>
    tx.ledgerCommit.findMany({
      where: { userId, transactionId },
      orderBy: { createdAt: "asc" },
    }),
  );

  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    previousHash: row.previousHash,
    currentHash: row.currentHash,
    patchData: row.patchData as unknown as LedgerCommitState,
    createdAt: row.createdAt,
  }));
}

export type LedgerVerificationResult = {
  valid: boolean;
  /** The id of the first commit whose stored hash doesn't match what's recomputed from its own patchData/previousHash — null when `valid` is true or there are no commits at all. */
  brokenAtCommitId: string | null;
};

/**
 * Recomputes every commit's hash from its own stored `patchData` and
 * `previousHash`, in chain order, and confirms it matches the stored
 * `currentHash` — AND that each commit's `previousHash` actually equals
 * the prior commit's `currentHash`. Either check failing means the
 * chain was broken: either a row's content was altered after the fact
 * (recomputed hash won't match what's stored) or a row was
 * deleted/inserted out of band (the link to the prior commit won't
 * match). Since `LedgerCommit` itself is append-only at the database
 * level (REVOKE UPDATE/DELETE + a rejection trigger,
 * prisma/migrations/*_ledger_commit_versioning), neither of those should
 * ever actually happen through this app's own runtime role — this
 * function is what makes that guarantee CHECKABLE rather than merely
 * asserted.
 */
export async function verifyLedgerChain(userId: string, transactionId: string): Promise<LedgerVerificationResult> {
  const commits = await getLedgerHistory(userId, transactionId);

  let expectedPreviousHash: string | null = null;
  for (const commit of commits) {
    if (commit.previousHash !== expectedPreviousHash) {
      return { valid: false, brokenAtCommitId: commit.id };
    }
    const recomputed = computeLedgerCommitHash(commit.previousHash, commit.patchData);
    if (recomputed !== commit.currentHash) {
      return { valid: false, brokenAtCommitId: commit.id };
    }
    expectedPreviousHash = commit.currentHash;
  }

  return { valid: true, brokenAtCommitId: null };
}
