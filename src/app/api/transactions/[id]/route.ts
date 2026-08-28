import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getIdempotentResponse, storeIdempotentResponse } from "../../../../server/api/idempotency";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonNotFound, jsonServerError } from "../../../../server/api/responses";
import { recordAuditLog } from "../../../../server/dal/audit-log";
import { getTransactionById, updateTransactionCategory } from "../../../../server/dal/transactions";

const PatchBodySchema = z.object({
  categoryId: z.string().min(1, "categoryId is required"),
});

/**
 * The /transactions screen's "inline recategorisation" mutation.
 * Idempotency-Key is optional here (not required, unlike a balance
 * mutation or trade submission — Section 2.4) since recategorizing is
 * naturally idempotent already: setting the same category twice has the
 * same end state. Supporting the header anyway proves the mechanism end
 * to end ahead of the routes that genuinely need it (trades, payments).
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardMutation(request, "transactions:patch");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  const { id } = await params;

  const idempotencyKey = request.headers.get("Idempotency-Key");
  if (idempotencyKey) {
    const cached = getIdempotentResponse(user.id, idempotencyKey);
    if (cached) {
      return NextResponse.json(cached.body, { status: cached.status });
    }
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonBadRequest("Request body must be valid JSON");
  }

  const parsed = PatchBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return jsonBadRequest("Invalid request body", parsed.error.issues);
  }

  try {
    // Fetched only for the audit log's "before" snapshot — the mutation
    // itself re-checks ownership independently inside updateTransactionCategory.
    const before = await getTransactionById(user.id, id);

    const updated = await updateTransactionCategory(user.id, id, parsed.data.categoryId);
    if (!updated) {
      // Covers both "transaction not found/not yours" and "category not
      // found/not yours" — never a 403 either way (Section 2.2).
      return jsonNotFound();
    }

    await recordAuditLog(user.id, {
      entityType: "NotableTransaction",
      entityId: id,
      action: "UPDATE",
      beforeData: before ? { categoryId: before.categoryId } : undefined,
      afterData: { categoryId: updated.categoryId },
    });

    const responseBody = { ok: true, categoryId: updated.categoryId, categoryName: updated.category.name };

    if (idempotencyKey) {
      storeIdempotentResponse(user.id, idempotencyKey, 200, responseBody);
    }

    return NextResponse.json(responseBody);
  } catch (error) {
    console.error("PATCH /api/transactions/[id] failed", error);
    return jsonServerError();
  }
}
