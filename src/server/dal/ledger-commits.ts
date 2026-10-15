import "server-only";
import type { LedgerCommitAction, Prisma } from "../../generated/prisma/client";
import { computeLedgerCommitHash, type LedgerCommitState, type LedgerSplitState } from "../../lib/ledger-hash";

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
  /** A Prisma `Decimal(12,6)`; null for a shekel row. */
  exchangeRateAtEntry?: { toFixed(digits: number): string } | null;
  /**
   * The row's splits (AGENTS.md §3xxx), with each category's current name.
   * Every path that appends a commit for a row that may be split must pass
   * them, or the commit would record the row as unsplit and verification
   * would then report the live splits as tampering. `SPLIT_STATE_SELECT`
   * reads exactly this shape.
   */
  splits?: readonly { categoryId: string; amount: bigint; nativeAmount: bigint; category: { name: string } }[];
};

/** The `include` that gives `buildLedgerState` a row's splits. */
export const SPLIT_STATE_SELECT = {
  select: { categoryId: true, amount: true, nativeAmount: true, category: { select: { name: true } } },
} as const;

function splitStates(splits: NonNullable<LedgerableTransaction["splits"]>): LedgerSplitState[] {
  return [...splits]
    .sort((a, b) => (a.categoryId < b.categoryId ? -1 : a.categoryId > b.categoryId ? 1 : 0))
    .map((split) => ({
      categoryId: split.categoryId,
      categoryName: split.category.name,
      amountAgorot: split.amount.toString(),
      nativeAmount: split.nativeAmount.toString(),
    }));
}

export function buildLedgerState(row: LedgerableTransaction): LedgerCommitState {
  const state: LedgerCommitState = {
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
  // Only a foreign-currency row carries a rate, and only then is it hashed,
  // so a shekel row's state (and every commit written before rates were
  // hashed) is unchanged.
  if (row.currency !== "ILS" && row.exchangeRateAtEntry) {
    state.exchangeRate = row.exchangeRateAtEntry.toFixed(6);
  }
  // Only a split row carries splits, so an unsplit row's state is unchanged.
  if (row.splits && row.splits.length > 0) state.splits = splitStates(row.splits);
  return state;
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
  /**
   * The money fields where the live row differs from its latest commit
   * (AGENTS.md §3www) — empty when they agree or there are no commits.
   * When non-empty, `valid` is false and `brokenAtCommitId` is that latest
   * commit.
   */
  mismatchedFields: string[];
};

/**
 * The fields of a row that nothing in this app ever changes after the row
 * is created, so its latest commit must still hold them exactly. Category,
 * description, merchant and the deleted flag are left out: each of those
 * changes through a path that appends its own commit, and a category
 * RENAME (which does not) would otherwise read as tampering.
 */
const IMMUTABLE_MONEY_FIELDS = ["amountAgorot", "currency", "nativeAmount", "occurredAtIso"] as const;

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
 *
 * Then it compares the LIVE row with the latest commit (AGENTS.md §3www):
 * amount, currency, native amount, date, and the exchange rate when that
 * commit recorded one, and the splits (§3xxx). An intact chain alone proves only that the history
 * is unaltered; without this check, editing the transaction row itself
 * (its amount, or the rate it was converted at) would go unnoticed.
 */
export async function verifyLedgerChain(userId: string, transactionId: string): Promise<LedgerVerificationResult> {
  const commits = await getLedgerHistory(userId, transactionId);

  let expectedPreviousHash: string | null = null;
  for (const commit of commits) {
    if (commit.previousHash !== expectedPreviousHash) {
      return { valid: false, brokenAtCommitId: commit.id, mismatchedFields: [] };
    }
    const recomputed = computeLedgerCommitHash(commit.previousHash, commit.patchData);
    if (recomputed !== commit.currentHash) {
      return { valid: false, brokenAtCommitId: commit.id, mismatchedFields: [] };
    }
    expectedPreviousHash = commit.currentHash;
  }

  const head = commits.at(-1);
  if (!head) return { valid: true, brokenAtCommitId: null, mismatchedFields: [] };

  const row = await withUserScope(userId, (tx) =>
    tx.notableTransaction.findFirst({
      where: { id: transactionId, userId },
      select: {
        amount: true,
        currency: true,
        nativeAmount: true,
        occurredAt: true,
        exchangeRateAtEntry: true,
        splits: { select: { categoryId: true, amount: true, nativeAmount: true } },
      },
    }),
  );
  if (!row) return { valid: true, brokenAtCommitId: null, mismatchedFields: [] };

  const live: Record<(typeof IMMUTABLE_MONEY_FIELDS)[number], string> = {
    amountAgorot: row.amount.toString(),
    currency: row.currency,
    nativeAmount: row.nativeAmount.toString(),
    occurredAtIso: row.occurredAt.toISOString(),
  };
  const mismatchedFields: string[] = IMMUTABLE_MONEY_FIELDS.filter((field) => head.patchData[field] !== live[field]);
  // A commit written before rates were hashed has no `exchangeRate` key;
  // only a commit that recorded one can be held to it.
  if ("exchangeRate" in head.patchData && head.patchData.exchangeRate !== (row.exchangeRateAtEntry?.toFixed(6) ?? undefined)) {
    mismatchedFields.push("exchangeRate");
  }
  // The live splits must be exactly the ones the latest commit recorded
  // (AGENTS.md §3xxx): same categories, same amounts in both units. The
  // category NAME is left out, as for the row itself, because a rename
  // appends no commit.
  const recordedSplits = (head.patchData.splits ?? []).map((split) => `${split.categoryId}:${split.amountAgorot}:${split.nativeAmount}`);
  const liveSplits = [...row.splits]
    .sort((a, b) => (a.categoryId < b.categoryId ? -1 : a.categoryId > b.categoryId ? 1 : 0))
    .map((split) => `${split.categoryId}:${split.amount}:${split.nativeAmount}`);
  if (recordedSplits.join("|") !== liveSplits.join("|")) mismatchedFields.push("splits");

  return mismatchedFields.length > 0
    ? { valid: false, brokenAtCommitId: head.id, mismatchedFields }
    : { valid: true, brokenAtCommitId: null, mismatchedFields: [] };
}
