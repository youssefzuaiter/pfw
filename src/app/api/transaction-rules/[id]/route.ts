import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { RuleActionsSchema, RuleConditionsSchema } from "../../../../lib/categorization/rule-engine";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonNotFound, jsonServerError } from "../../../../server/api/responses";
import { recordAuditLog } from "../../../../server/dal/audit-log";
import { deleteTransactionRule, updateTransactionRule } from "../../../../server/dal/transaction-rules";

const PatchBodySchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  priority: z.number().int().min(0).max(10_000).optional(),
  isActive: z.boolean().optional(),
  conditions: RuleConditionsSchema.optional(),
  actions: RuleActionsSchema.optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardMutation(request, "transaction-rules:patch");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  const { id } = await params;

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
  if (Object.values(parsed.data).every((value) => value === undefined)) {
    return jsonBadRequest("Provide at least one field to update");
  }

  try {
    const updated = await updateTransactionRule(user.id, id, parsed.data);
    if (!updated) return jsonNotFound();

    await recordAuditLog(user.id, {
      entityType: "TransactionRule",
      entityId: id,
      action: "UPDATE",
      afterData: parsed.data,
    });

    return NextResponse.json({ ok: true, rule: updated });
  } catch (error) {
    console.error("PATCH /api/transaction-rules/[id] failed", error);
    return jsonServerError();
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardMutation(request, "transaction-rules:delete");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  const { id } = await params;

  try {
    const result = await deleteTransactionRule(user.id, id);
    if (!result.ok) return jsonNotFound();

    await recordAuditLog(user.id, { entityType: "TransactionRule", entityId: id, action: "DELETE" });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("DELETE /api/transaction-rules/[id] failed", error);
    return jsonServerError();
  }
}
