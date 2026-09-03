import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { RuleActionsSchema, RuleConditionsSchema } from "../../../lib/categorization/rule-engine";
import { guardMutation } from "../../../server/api/guard-mutation";
import { jsonBadRequest, jsonServerError } from "../../../server/api/responses";
import { recordAuditLog } from "../../../server/dal/audit-log";
import { createTransactionRule } from "../../../server/dal/transaction-rules";

/**
 * Tier 0 rule management (the rule-engine plan). No `GET` here — the
 * `/transactions/rules` screen is a Server Component calling
 * `listTransactionRules` directly, same RSC-read convention every other
 * management screen in this app uses (`/categories`, `/budgets`) rather
 * than a separate JSON API for a read with no independent interactivity
 * to justify one (AGENTS.md §3n's own reasoning for when a real GET
 * route *does* earn its keep).
 */
const CreateBodySchema = z.object({
  name: z.string().trim().min(1, "name is required").max(80, "name is too long"),
  priority: z.number().int().min(0).max(10_000).optional(),
  isActive: z.boolean().optional(),
  conditions: RuleConditionsSchema,
  actions: RuleActionsSchema,
});

export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "transaction-rules:create");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonBadRequest("Request body must be valid JSON");
  }

  const parsed = CreateBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return jsonBadRequest("Invalid request body", parsed.error.issues);
  }

  try {
    const rule = await createTransactionRule(user.id, {
      name: parsed.data.name,
      priority: parsed.data.priority ?? 0,
      isActive: parsed.data.isActive ?? true,
      conditions: parsed.data.conditions,
      actions: parsed.data.actions,
    });

    await recordAuditLog(user.id, {
      entityType: "TransactionRule",
      entityId: rule.id,
      action: "CREATE",
      afterData: { name: rule.name, priority: rule.priority, isActive: rule.isActive },
    });

    return NextResponse.json({ ok: true, rule }, { status: 201 });
  } catch (error) {
    console.error("POST /api/transaction-rules failed", error);
    return jsonServerError();
  }
}
