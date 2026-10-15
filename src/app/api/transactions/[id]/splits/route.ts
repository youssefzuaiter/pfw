import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { guardMutation } from "../../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonNotFound, jsonServerError } from "../../../../../server/api/responses";
import { recordAuditLog } from "../../../../../server/dal/audit-log";
import { setTransactionSplits } from "../../../../../server/dal/transaction-splits";
import { getTransactionById } from "../../../../../server/dal/transactions";
import { formatNativeAmount, nativeAmount, parseDecimalToNativeAmount, type CurrencyCode } from "../../../../../lib/currency";
import { describeSplitError, MAX_SPLITS, type SplitRequest } from "../../../../../lib/transaction-splits";

/** An unsigned amount in the transaction's own currency, at most two decimals. */
const AmountSchema = z.string().trim().regex(/^\d{1,13}(\.\d{1,2})?$/, "Enter an amount like 12.50.");

const BodySchema = z.object({
  /** Empty puts the transaction back in one category. */
  splits: z
    .array(z.object({ categoryId: z.string().min(1).max(64), amount: AmountSchema }))
    .max(MAX_SPLITS),
});

const DAL_ERRORS: Record<"is_transfer" | "category_not_found" | "category_not_allowed", { status: number; message: string }> = {
  is_transfer: { status: 409, message: "A transfer between your own accounts can't be split." },
  category_not_found: { status: 404, message: "One of those categories doesn't exist." },
  category_not_allowed: { status: 400, message: "Pick active categories other than Uncategorized." },
};

/**
 * Sets how a transaction divides across categories (AGENTS.md §3xxx), or
 * removes the split. The amounts must add up to the transaction's amount in
 * its own currency exactly; one agorah off is a 400 that names the
 * difference. A real change appends a ledger commit listing the splits.
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardMutation(request, "transactions:splits");
  if ("response" in guard) return guard.response;
  const { user } = guard;
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonBadRequest("Request body must be valid JSON.");
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return jsonBadRequest(parsed.error.issues[0]?.message ?? "Invalid request body.");

  try {
    const transaction = await getTransactionById(user.id, id);
    if (!transaction || transaction.deletedAt) return jsonNotFound();
    const currency = transaction.currency as CurrencyCode;

    const requests: SplitRequest[] = parsed.data.splits.map((split) => ({
      categoryId: split.categoryId,
      nativeAmount: BigInt(parseDecimalToNativeAmount(split.amount)),
    }));

    const result = await setTransactionSplits(user.id, id, requests);
    if (!result.ok) {
      if (result.error === "not_found") return jsonNotFound();
      if (result.error === "invalid_split") {
        const format = (minorUnits: bigint) => formatNativeAmount(nativeAmount(Number(minorUnits)), currency);
        return NextResponse.json({ error: describeSplitError(result.detail, format), code: result.detail.error }, { status: 400 });
      }
      const known = DAL_ERRORS[result.error];
      return NextResponse.json({ error: known.message, code: result.error }, { status: known.status });
    }

    if (result.changed) {
      await recordAuditLog(user.id, {
        entityType: "NotableTransaction",
        entityId: id,
        action: "UPDATE",
        afterData: {
          splits: result.parts.map((part) => ({ categoryId: part.categoryId, amountAgorot: part.amount.toString() })),
        },
      });
    }

    return NextResponse.json({
      ok: true,
      changed: result.changed,
      categoryId: result.categoryId,
      splits: result.parts.map((part) => ({
        categoryId: part.categoryId,
        amountAgorot: Number(part.amount),
        nativeAmount: Number(part.nativeAmount),
      })),
    });
  } catch (error) {
    console.error("PUT /api/transactions/[id]/splits failed", error);
    return jsonServerError();
  }
}
