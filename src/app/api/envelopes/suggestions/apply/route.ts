import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isValidMonthKey } from "../../../../../lib/date-month";
import { formatAgorot, parseShekelsToAgorot } from "../../../../../lib/money";
import { guardMutation } from "../../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonServerError } from "../../../../../server/api/responses";
import { recordAuditLog } from "../../../../../server/dal/audit-log";
import { applyEnvelopeSuggestions, MAX_SUGGESTION_ITEMS } from "../../../../../server/dal/envelope-suggestions";

const BodySchema = z.object({
  month: z.string().refine(isValidMonthKey, { message: "month must be in YYYY-MM format" }),
  items: z
    .array(z.object({ categoryId: z.string().trim().min(1).max(60), amount: z.string().trim().min(1).max(20) }))
    .min(1, "Tick at least one envelope")
    .max(MAX_SUGGESTION_ITEMS, `Set at most ${MAX_SUGGESTION_ITEMS} envelopes at a time`),
});

/**
 * Sets several envelopes for a month at once from the suggested amounts
 * (AGENTS.md §3mmmm). All or nothing; never overwrites a budget already set;
 * refuses a total above what is available to budget. Amounts are shekel
 * strings parsed server-side like every other money input.
 */
export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "envelopes:suggestions");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonBadRequest("Request body must be valid JSON.");
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return jsonBadRequest(parsed.error.issues[0]?.message ?? "Invalid request body.");

  const items: { categoryId: string; amountAgorot: ReturnType<typeof parseShekelsToAgorot> }[] = [];
  for (const item of parsed.data.items) {
    let amountAgorot;
    try {
      amountAgorot = parseShekelsToAgorot(item.amount);
    } catch {
      return jsonBadRequest(`"${item.amount}" is not a valid amount.`);
    }
    if (amountAgorot <= 0) return jsonBadRequest("Each amount must be more than zero.");
    items.push({ categoryId: item.categoryId, amountAgorot });
  }
  if (new Set(items.map((item) => item.categoryId)).size !== items.length) return jsonBadRequest("Each envelope can be set only once.");

  try {
    const result = await applyEnvelopeSuggestions(user.id, parsed.data.month, items);
    if (!result.ok) {
      if (result.error === "exceeds_available") {
        return jsonBadRequest(`These add up to ${formatAgorot(result.requestedAgorot)} but only ${formatAgorot(result.availableAgorot)} is available to budget.`);
      }
      if (result.error === "already_set") return jsonBadRequest("One of these envelopes already has an amount for this month. Reload the page.");
      return jsonBadRequest("One of those categories does not exist.");
    }

    await recordAuditLog(user.id, {
      action: "UPDATE",
      entityType: "EnvelopeAllocation",
      entityId: `bulk:${parsed.data.month}`,
      afterData: { month: parsed.data.month, envelopes: result.applied, totalAgorot: result.totalAgorot },
    });
    return NextResponse.json({ ok: true, applied: result.applied, totalAgorot: result.totalAgorot });
  } catch (error) {
    console.error("POST /api/envelopes/suggestions/apply failed", error);
    return jsonServerError();
  }
}
