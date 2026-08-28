import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseShekelsToAgorot } from "../../../lib/money";
import { guardMutation } from "../../../server/api/guard-mutation";
import { jsonBadRequest, jsonServerError } from "../../../server/api/responses";
import { recordAuditLog } from "../../../server/dal/audit-log";
import { createGoal } from "../../../server/dal/goals";

const BodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  targetAmount: z.string().min(1),
  targetDate: z.string().datetime().optional(),
});

export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "goals:create");
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

  let targetAmountAgorot: ReturnType<typeof parseShekelsToAgorot>;
  try {
    targetAmountAgorot = parseShekelsToAgorot(parsed.data.targetAmount);
  } catch {
    return jsonBadRequest("Invalid target amount");
  }
  if (targetAmountAgorot <= 0) {
    return jsonBadRequest("Target amount must be positive");
  }

  try {
    const goal = await createGoal(user.id, {
      name: parsed.data.name,
      targetAmount: BigInt(targetAmountAgorot),
      targetDate: parsed.data.targetDate ? new Date(parsed.data.targetDate) : undefined,
    });

    await recordAuditLog(user.id, {
      entityType: "Goal",
      entityId: goal.id,
      action: "CREATE",
      afterData: { name: goal.name, targetAmount: targetAmountAgorot },
    });

    return NextResponse.json(
      { ok: true, goal: { id: goal.id, name: goal.name, targetAmount: Number(goal.targetAmount) } },
      { status: 201 },
    );
  } catch (error) {
    console.error("POST /api/goals failed", error);
    return jsonServerError();
  }
}
