import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { BASE_CURRENCY, isSupportedCurrency, parseDecimalToNativeAmount, type CurrencyCode } from "../../../lib/currency";
import { parseShekelsToAgorot } from "../../../lib/money";
import { EmbeddingSchema } from "../../../server/api/embedding-validation";
import { guardMutation } from "../../../server/api/guard-mutation";
import { jsonBadRequest, jsonNotFound, jsonServerError } from "../../../server/api/responses";
import { recordAuditLog } from "../../../server/dal/audit-log";
import { getBankAccountById } from "../../../server/dal/bank-accounts";
import { BankAccountNotFoundError } from "../../../server/dal/transaction-import";
import { lockRateFor, NoRateForDayError, toAgorotAtLockedRate, type LockedRate } from "../../../server/currency/lock-rate";
import { createTransaction } from "../../../server/dal/transactions";

const MAX_TEXT_LENGTH = 500;

const BodySchema = z.object({
  bankAccountId: z.string().min(1),
  // Signed shekel string: "-45.90" for an expense (the common case — a
  // manually-entered or receipt-scanned transaction is virtually always
  // an expense, but the field accepts a positive value too rather than
  // silently negating everything).
  /** In `currency`, signed, at most two decimals. */
  amount: z.string().min(1),
  /** The currency `amount` is in; defaults to the account's own currency. */
  currency: z.custom<CurrencyCode>((value) => typeof value === "string" && isSupportedCurrency(value), "Unsupported currency").optional(),
  /**
   * The shekel figure the form showed (signed agorot, as a string). Required
   * for any currency other than shekels: if the rate the server locks gives
   * a different figure (a rate sync ran in between), the request is refused
   * with 409 rather than storing a number the user never saw.
   */
  expectedAmountAgorot: z.string().regex(/^-?\d{1,15}$/).optional(),
  occurredAt: z.string().datetime(),
  description: z.string().trim().min(1).max(MAX_TEXT_LENGTH),
  merchantName: z.string().trim().min(1).max(MAX_TEXT_LENGTH).optional(),
  // Self-Learning Vector Categorization Engine (AGENTS.md §3u) — see
  // embedding-validation.ts's doc comment.
  embedding: EmbeddingSchema,
});

/**
 * Manual transaction creation (AGENTS.md §3q) — the first route in this
 * app that creates a `NotableTransaction` outside CSV import or the
 * seed script. Used by the receipt-scanner review form, but the shape
 * is generic: any hand-typed transaction is welcome to use it too, not
 * only an OCR-derived one — the server has no way to tell the
 * difference between "typed from a receipt" and "typed from memory,"
 * and doesn't need to.
 */
export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "transactions:create");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonBadRequest("Request body must be valid JSON");
  }

  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return jsonBadRequest("Invalid request body", parsed.error.issues);
  }

  const account = await getBankAccountById(user.id, parsed.data.bankAccountId);
  if (!account) return jsonNotFound();
  const currency: CurrencyCode = parsed.data.currency ?? account.currency;

  let nativeAmount: number;
  try {
    // Shekels keep accepting a typed "₪", as this route always has.
    nativeAmount = currency === BASE_CURRENCY ? parseShekelsToAgorot(parsed.data.amount) : parseDecimalToNativeAmount(parsed.data.amount);
  } catch {
    return jsonBadRequest("Invalid amount");
  }
  if (nativeAmount === 0) {
    return jsonBadRequest("Amount must not be zero");
  }

  // The rate is locked here, by the server, for the transaction's own UTC
  // day (AGENTS.md §3www). Nothing the client sends about the rate is used.
  let locked: LockedRate | null = null;
  let amountAgorot = nativeAmount;
  if (currency !== BASE_CURRENCY) {
    if (parsed.data.expectedAmountAgorot === undefined) {
      return jsonBadRequest("expectedAmountAgorot is required for an amount not in shekels");
    }
    try {
      locked = await lockRateFor(currency, parsed.data.occurredAt);
    } catch (error) {
      if (error instanceof NoRateForDayError) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: 422 });
      }
      throw error;
    }
    amountAgorot = toAgorotAtLockedRate(nativeAmount, locked);
    if (amountAgorot === 0) {
      return jsonBadRequest("Amount is too small to record in shekels");
    }
    if (String(amountAgorot) !== parsed.data.expectedAmountAgorot) {
      return NextResponse.json(
        {
          error: "The exchange rate changed since the preview. Check the new shekel amount and submit again.",
          code: "rate_changed",
          amountAgorot,
          rate: locked.rate,
          rateDay: locked.rateDay,
        },
        { status: 409 },
      );
    }
  }

  try {
    const created = await createTransaction(user.id, {
      bankAccountId: parsed.data.bankAccountId,
      amountAgorot: BigInt(amountAgorot),
      entered: locked ? { currency, nativeAmount: BigInt(nativeAmount), exchangeRate: locked.rate } : undefined,
      occurredAt: new Date(parsed.data.occurredAt),
      description: parsed.data.description,
      merchantName: parsed.data.merchantName,
      embedding: parsed.data.embedding,
    });

    await recordAuditLog(user.id, {
      entityType: "NotableTransaction",
      entityId: created.id,
      action: "CREATE",
      afterData: {
        bankAccountId: parsed.data.bankAccountId,
        amountAgorot,
        currency,
        nativeAmount,
        exchangeRate: locked?.rate ?? null,
        rateDay: locked?.rateDay ?? null,
      },
    });

    return NextResponse.json(
      {
        ok: true,
        transaction: {
          id: created.id,
          occurredAt: created.occurredAt.toISOString(),
          amount: Number(created.amount),
          currency: created.currency,
          nativeAmount: Number(created.nativeAmount),
          exchangeRate: locked?.rate ?? null,
          rateDay: locked?.rateDay ?? null,
          categoryId: created.categoryId,
          categoryName: created.category.name,
          needsReview: created.needsReview,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof BankAccountNotFoundError) {
      return jsonNotFound();
    }
    console.error("POST /api/transactions failed", error);
    return jsonServerError();
  }
}
