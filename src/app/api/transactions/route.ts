import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseShekelsToAgorot } from "../../../lib/money";
import { EmbeddingSchema } from "../../../server/api/embedding-validation";
import { guardMutation } from "../../../server/api/guard-mutation";
import { jsonBadRequest, jsonNotFound, jsonServerError } from "../../../server/api/responses";
import { recordAuditLog } from "../../../server/dal/audit-log";
import { BankAccountNotFoundError } from "../../../server/dal/transaction-import";
import { createTransaction } from "../../../server/dal/transactions";

const MAX_TEXT_LENGTH = 500;

const BodySchema = z.object({
  bankAccountId: z.string().min(1),
  // Signed shekel string: "-45.90" for an expense (the common case — a
  // manually-entered or receipt-scanned transaction is virtually always
  // an expense, but the field accepts a positive value too rather than
  // silently negating everything).
  amount: z.string().min(1),
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

  let amountAgorot: ReturnType<typeof parseShekelsToAgorot>;
  try {
    amountAgorot = parseShekelsToAgorot(parsed.data.amount);
  } catch {
    return jsonBadRequest("Invalid amount");
  }
  if (amountAgorot === 0) {
    return jsonBadRequest("Amount must not be zero");
  }

  try {
    const created = await createTransaction(user.id, {
      bankAccountId: parsed.data.bankAccountId,
      amountAgorot: BigInt(amountAgorot),
      occurredAt: new Date(parsed.data.occurredAt),
      description: parsed.data.description,
      merchantName: parsed.data.merchantName,
      embedding: parsed.data.embedding,
    });

    await recordAuditLog(user.id, {
      entityType: "NotableTransaction",
      entityId: created.id,
      action: "CREATE",
      afterData: { bankAccountId: parsed.data.bankAccountId, amountAgorot: Number(amountAgorot) },
    });

    return NextResponse.json(
      {
        ok: true,
        transaction: {
          id: created.id,
          occurredAt: created.occurredAt.toISOString(),
          amount: Number(created.amount),
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
