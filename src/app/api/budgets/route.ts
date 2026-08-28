import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseShekelsToAgorot } from "../../../lib/money";
import { guardMutation } from "../../../server/api/guard-mutation";
import { jsonBadRequest, jsonNotFound, jsonServerError } from "../../../server/api/responses";
import { recordAuditLog } from "../../../server/dal/audit-log";
import { upsertBudget } from "../../../server/dal/budgets";

const BodySchema = z.object({
  categoryId: z.string().min(1),
  // A shekel-amount string (e.g. "500.00"), parsed server-side via the
  // one audited money utility — never trust a client to have done its
  // own float math for a monetary value.
  monthlyLimit: z.string().min(1),
});

export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "budgets:upsert");
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

  let monthlyLimitAgorot: ReturnType<typeof parseShekelsToAgorot>;
  try {
    monthlyLimitAgorot = parseShekelsToAgorot(parsed.data.monthlyLimit);
  } catch {
    return jsonBadRequest("Invalid monthly limit amount");
  }
  if (monthlyLimitAgorot <= 0) {
    return jsonBadRequest("Monthly limit must be positive");
  }

  try {
    const budget = await upsertBudget(user.id, parsed.data.categoryId, BigInt(monthlyLimitAgorot));
    if (!budget) return jsonNotFound();

    await recordAuditLog(user.id, {
      entityType: "Budget",
      entityId: budget.id,
      action: "UPDATE",
      afterData: { categoryId: parsed.data.categoryId, monthlyLimit: monthlyLimitAgorot },
    });

    return NextResponse.json(
      { ok: true, budget: { id: budget.id, categoryId: budget.categoryId, monthlyLimit: Number(budget.monthlyLimit) } },
      { status: 201 },
    );
  } catch (error) {
    console.error("POST /api/budgets failed", error);
    return jsonServerError();
  }
}
