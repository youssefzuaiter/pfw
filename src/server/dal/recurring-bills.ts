import "server-only";
import type { CurrencyCode } from "../../lib/currency";
import { manualBillKey, type RecurringBillInput, type RecurringBillKind } from "../../lib/recurring-bills";
import { withUserScope, type ScopedTransactionClient } from "../db/with-user-scope";

/**
 * Subscriptions and bills the user typed in (AGENTS.md §3cccc). Every function
 * takes `userId` and runs under row-level security, so another user's bill is
 * indistinguishable from one that does not exist: the writes return `null` or
 * `false`, which the routes turn into a 404 (Section 2.2).
 */

export type BillCadenceName = RecurringBillInput["cadence"];

const CADENCE_FROM_DB = { MONTHLY: "monthly", QUARTERLY: "quarterly", ANNUAL: "annual" } as const;
const CADENCE_TO_DB = { monthly: "MONTHLY", quarterly: "QUARTERLY", annual: "ANNUAL" } as const;

const KIND_FROM_DB = { BILL: "bill", SUBSCRIPTION: "subscription" } as const;
const KIND_TO_DB = { bill: "BILL", subscription: "SUBSCRIPTION" } as const;

type BillRow = {
  id: string;
  kind: keyof typeof KIND_FROM_DB;
  amountVaries: boolean;
  name: string;
  nativeAmount: bigint;
  currency: string;
  cadence: keyof typeof CADENCE_FROM_DB;
  anchorDate: Date;
  categoryId: string | null;
};

function toBill(row: BillRow): RecurringBillInput {
  return {
    id: row.id,
    kind: KIND_FROM_DB[row.kind],
    amountVaries: row.amountVaries,
    name: row.name,
    nativeAmount: Number(row.nativeAmount),
    currency: row.currency as CurrencyCode,
    cadence: CADENCE_FROM_DB[row.cadence],
    anchorDate: row.anchorDate,
    categoryId: row.categoryId,
  };
}

export async function listRecurringBills(userId: string): Promise<RecurringBillInput[]> {
  const rows = await withUserScope(userId, (tx) =>
    tx.recurringBill.findMany({ where: { userId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
  );
  return rows.map(toBill);
}

export type RecurringBillWrite = {
  name: string;
  /** Billed by use: different every time. Unlike the kind, this can be changed when editing. */
  amountVaries: boolean;
  /** Positive, minor units of `currency`. */
  nativeAmount: number;
  currency: CurrencyCode;
  cadence: BillCadenceName;
  anchorDate: Date;
  categoryId: string | null;
};

/** What creating takes: the details plus which page it belongs to. The kind is never changed afterwards. */
export type RecurringBillCreate = RecurringBillWrite & { kind: RecurringBillKind };

export type RecurringBillResult = { ok: true; bill: RecurringBillInput } | { ok: false; error: "category_not_found" };

/** The category must be the caller's own; a missing or someone else's is refused the same way. */
async function categoryIsOwned(tx: ScopedTransactionClient, userId: string, categoryId: string | null) {
  if (categoryId === null) return true;
  return (await tx.category.findFirst({ where: { id: categoryId, userId }, select: { id: true } })) !== null;
}

export async function createRecurringBill(userId: string, input: RecurringBillCreate): Promise<RecurringBillResult> {
  return withUserScope(userId, async (tx) => {
    if (!(await categoryIsOwned(tx, userId, input.categoryId))) return { ok: false, error: "category_not_found" } as const;
    const row = await tx.recurringBill.create({
      data: {
        userId,
        kind: KIND_TO_DB[input.kind],
        amountVaries: input.amountVaries,
        name: input.name,
        nativeAmount: BigInt(input.nativeAmount),
        currency: input.currency,
        cadence: CADENCE_TO_DB[input.cadence],
        anchorDate: input.anchorDate,
        categoryId: input.categoryId,
      },
    });
    return { ok: true, bill: toBill(row) } as const;
  });
}

/** `null` when the bill does not exist or is not the caller's. */
export async function updateRecurringBill(
  userId: string,
  id: string,
  input: RecurringBillWrite,
): Promise<RecurringBillResult | null> {
  return withUserScope(userId, async (tx) => {
    const existing = await tx.recurringBill.findFirst({ where: { id, userId }, select: { id: true } });
    if (!existing) return null;
    if (!(await categoryIsOwned(tx, userId, input.categoryId))) return { ok: false, error: "category_not_found" } as const;
    const row = await tx.recurringBill.update({
      where: { id },
      data: {
        name: input.name,
        amountVaries: input.amountVaries,
        nativeAmount: BigInt(input.nativeAmount),
        currency: input.currency,
        cadence: CADENCE_TO_DB[input.cadence],
        anchorDate: input.anchorDate,
        categoryId: input.categoryId,
      },
    });
    return { ok: true, bill: toBill(row) } as const;
  });
}

/** Deletes the bill and the cancel/review state kept for it. `false` when it does not exist or is not the caller's. */
export async function deleteRecurringBill(userId: string, id: string): Promise<boolean> {
  return withUserScope(userId, async (tx) => {
    const { count } = await tx.recurringBill.deleteMany({ where: { id, userId } });
    if (count === 0) return false;
    await tx.subscriptionTracking.deleteMany({ where: { userId, merchantKey: manualBillKey(id) } });
    return true;
  });
}
