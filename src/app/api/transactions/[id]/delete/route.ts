import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { guardMutation } from "../../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonNotFound, jsonServerError } from "../../../../../server/api/responses";
import { recordAuditLog } from "../../../../../server/dal/audit-log";
import { restoreTransaction, softDeleteTransaction } from "../../../../../server/dal/transactions";

const BodySchema = z.object({
  /** `false` restores a previously deleted row. */
  deleted: z.boolean(),
});

/**
 * Soft-delete or restore one transaction.
 *
 * POST rather than DELETE because the same route does both directions,
 * and a DELETE that can un-delete reads worse than a state change. The
 * row is never removed — LedgerCommit cascades from it and is
 * append-only at the database level, so a real delete is rejected by its
 * own trigger — and every call appends its own ledger commit, so the
 * tamper-evident history records the removal rather than losing it.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardMutation(request, "transactions:delete");
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
    const result = parsed.data.deleted
      ? await softDeleteTransaction(user.id, id)
      : await restoreTransaction(user.id, id);

    // Not found covers both a nonexistent id and another user's row
    // (Section 2.2) — never 403, which would confirm it exists.
    if (!result.ok) return jsonNotFound();

    await recordAuditLog(user.id, {
      action: parsed.data.deleted ? "DELETE" : "UPDATE",
      entityType: "NotableTransaction",
      entityId: id,
      afterData: { deletedAt: parsed.data.deleted ? new Date().toISOString() : null },
    });

    return NextResponse.json({ ok: true, deleted: parsed.data.deleted });
  } catch (error) {
    console.error("transaction delete failed", error);
    return jsonServerError();
  }
}
