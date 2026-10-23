import { findTransferMatches, type TransferCandidate, type TransferMatch } from "../../lib/transfer-matching";
import { withUserScope } from "../db/with-user-scope";
import type { ScopedTransactionClient } from "../db/with-user-scope";
import { REAL_MONEY } from "./transactions";

/** The most rows looked at in one pass: newest first, far more than a personal ledger holds. */
const MAX_CANDIDATE_ROWS = 20_000;

/** The most pairs one apply may mark: two rows each, so at most MAX_BULK_TRANSACTIONS rows. */
export const MAX_TRANSFER_PAIRS = 250;

async function loadCandidates(tx: ScopedTransactionClient, userId: string): Promise<TransferCandidate[]> {
  const rows = await tx.notableTransaction.findMany({
    // Live, not already a transfer, and not divided across categories (a split row cannot be a transfer).
    where: { userId, ...REAL_MONEY, splits: { none: {} } },
    orderBy: { occurredAt: "desc" },
    take: MAX_CANDIDATE_ROWS,
    select: {
      id: true,
      bankAccountId: true,
      occurredAt: true,
      currency: true,
      nativeAmount: true,
      amount: true,
      merchantName: true,
      // Never `last4`: it is encrypted, and a nested read would return ciphertext.
      bankAccount: { select: { nickname: true, institutionName: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    accountId: row.bankAccountId,
    accountLabel: row.bankAccount.nickname ?? row.bankAccount.institutionName,
    occurredAt: row.occurredAt,
    currency: row.currency,
    nativeAmount: Number(row.nativeAmount),
    amountAgorot: Number(row.amount),
    label: row.merchantName ?? "",
  }));
}

/** Proposed transfers between the user's own accounts (AGENTS.md §3kkkk). Writes nothing. */
export async function listTransferMatches(userId: string): Promise<TransferMatch[]> {
  return withUserScope(userId, async (tx) => findTransferMatches(await loadCandidates(tx, userId)));
}

export type TransferPairRequest = { outId: string; inId: string };

export type ApplyTransferMatchesResult = {
  /** Pairs marked. */
  applied: number;
  /** Requested pairs that no longer match (a row changed, was deleted, or was paired differently). */
  skipped: number;
  /** Every row marked, so the caller can offer to undo exactly those. */
  changedIds: string[];
};

/**
 * Marks both rows of each requested pair as a transfer. The pairs are
 * untrusted: the matching is run again here, and a pair is only applied if it
 * is still exactly what the matcher proposes, so a stale page, a hand-made
 * request or someone else's row ids cannot mark anything the matcher would not.
 * All or nothing, in one transaction.
 */
export async function applyTransferMatches(userId: string, pairs: readonly TransferPairRequest[]): Promise<ApplyTransferMatchesResult> {
  if (pairs.length === 0 || pairs.length > MAX_TRANSFER_PAIRS) {
    throw new RangeError(`Apply takes between 1 and ${MAX_TRANSFER_PAIRS} pairs`);
  }

  return withUserScope(
    userId,
    async (tx) => {
      const current = new Set(findTransferMatches(await loadCandidates(tx, userId)).map((match) => `${match.out.id}|${match.in.id}`));
      const changedIds: string[] = [];
      const seen = new Set<string>();
      let applied = 0;
      let skipped = 0;

      for (const pair of pairs) {
        const key = `${pair.outId}|${pair.inId}`;
        if (seen.has(key) || !current.has(key)) {
          skipped++;
          continue;
        }
        seen.add(key);
        // One update per row: updateMany is refused on a model with encrypted fields.
        for (const id of [pair.outId, pair.inId]) {
          await tx.notableTransaction.update({ where: { id }, data: { isTransfer: true } });
          changedIds.push(id);
        }
        applied++;
      }
      return { applied, skipped, changedIds };
    },
    { timeoutMs: 60_000 },
  );
}
