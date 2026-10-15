import "server-only";
import { planSplits, primaryPart, type SplitPart, type SplitPlanError, type SplitRequest } from "../../lib/transaction-splits";
import { withUserScope } from "../db/with-user-scope";
import { appendLedgerCommit, buildLedgerState, SPLIT_STATE_SELECT } from "./ledger-commits";
import { LIVE } from "./transactions";

export type SetSplitsResult =
  | { ok: true; changed: boolean; categoryId: string; parts: SplitPart[] }
  | { ok: false; error: "not_found" | "is_transfer" | "category_not_found" | "category_not_allowed" }
  | { ok: false; error: "invalid_split"; detail: SplitPlanError };

function sameParts(a: readonly SplitPart[], b: readonly SplitPart[]): boolean {
  const key = (parts: readonly SplitPart[]) =>
    parts
      .map((part) => `${part.categoryId}:${part.amount}:${part.nativeAmount}`)
      .sort()
      .join("|");
  return key(a) === key(b);
}

/**
 * Divides a transaction across categories, changes how it divides, or (with
 * no requests) puts it back in one category (AGENTS.md §3xxx).
 *
 * Amounts are typed in the transaction's own currency, unsigned; they must
 * add up to its amount exactly or nothing is written. The transaction is
 * filed under its largest part, so anything that shows one category for a
 * row still shows something true. Every real change appends a ledger commit
 * listing the splits, in the same database transaction; a request that
 * changes nothing appends none.
 *
 * Refused for a transfer between the user's own accounts (it is neither
 * income nor spending, so there is nothing to divide), and for a category
 * that is archived or is Uncategorized (a split is a decision about where
 * money went).
 */
export async function setTransactionSplits(
  userId: string,
  transactionId: string,
  requests: readonly SplitRequest[],
): Promise<SetSplitsResult> {
  return withUserScope(userId, async (tx) => {
    const row = await tx.notableTransaction.findFirst({
      where: { id: transactionId, userId, ...LIVE },
      include: { category: true, splits: SPLIT_STATE_SELECT },
    });
    if (!row) return { ok: false, error: "not_found" };
    if (row.isTransfer) return { ok: false, error: "is_transfer" };

    const currentParts: SplitPart[] = row.splits.map((split) => ({
      categoryId: split.categoryId,
      amount: split.amount,
      nativeAmount: split.nativeAmount,
    }));

    let parts: SplitPart[] = [];
    if (requests.length > 0) {
      const categoryIds = [...new Set(requests.map((request) => request.categoryId))];
      const categories = await tx.category.findMany({ where: { userId, id: { in: categoryIds } } });
      if (categories.length !== categoryIds.length) return { ok: false, error: "category_not_found" };
      if (categories.some((category) => category.archivedAt !== null || category.isUncategorized)) {
        return { ok: false, error: "category_not_allowed" };
      }
      const plan = planSplits(row, requests);
      if (!plan.ok) {
        const { ok: _ok, ...detail } = plan;
        void _ok;
        return { ok: false, error: "invalid_split", detail };
      }
      parts = plan.parts;
    }

    if (sameParts(parts, currentParts)) {
      return { ok: true, changed: false, categoryId: row.categoryId, parts: currentParts };
    }

    await tx.transactionSplit.deleteMany({ where: { userId, transactionId } });
    if (parts.length > 0) {
      await tx.transactionSplit.createMany({
        data: parts.map((part) => ({ userId, transactionId, categoryId: part.categoryId, amount: part.amount, nativeAmount: part.nativeAmount })),
      });
    }
    const categoryId = parts.length > 0 ? primaryPart(parts).categoryId : row.categoryId;

    const updated = await tx.notableTransaction.update({
      where: { id: transactionId },
      data: { categoryId, needsReview: false },
      include: { category: true, splits: SPLIT_STATE_SELECT },
    });
    await appendLedgerCommit(tx, userId, {
      transactionId,
      action: "UPDATE",
      state: buildLedgerState({ ...updated, categoryName: updated.category.name }),
    });

    return { ok: true, changed: true, categoryId, parts };
  });
}
