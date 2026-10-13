import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { guardMutation } from "../../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonServerError } from "../../../../../server/api/responses";
import { recordAuditLog } from "../../../../../server/dal/audit-log";
import { createRulesFromSuggestions } from "../../../../../server/dal/transaction-rules";
import { updateTransactionCategory } from "../../../../../server/dal/transactions";

const BodySchema = z.object({
  choices: z
    .array(z.object({ transactionId: z.string().min(1).max(64), categoryId: z.string().min(1).max(64) }))
    .min(1)
    .max(500),
  /** Suggestions the user also chose to keep as rules (AGENTS.md §3ooo). Optional: an older client sends none. */
  rules: z
    .array(
      z.object({
        field: z.enum(["merchantName", "description"]),
        keyword: z.string().trim().min(1).max(200),
        categoryId: z.string().min(1).max(64),
      }),
    )
    .max(100)
    .optional(),
});

/**
 * Applies the category choices the user accepted from the AI suggestions
 * (AGENTS.md §3kkk). Each row goes through the same `updateTransactionCategory`
 * as a hand recategorisation: ownership of both the transaction and the
 * category is checked, `needsReview` is cleared — which is what lets Tier 1
 * place the next import from the same merchant on its own — and the
 * ledger chain gets an UPDATE commit.
 *
 * A row that is not this user's, or a category that is not theirs, is
 * counted as skipped rather than failing the batch.
 *
 * `rules` are saved as `contains` → `categorize` rules in the same request,
 * so the next statement from those merchants is sorted without asking
 * Claude again. A duplicate of an existing rule is skipped, not repeated.
 */
export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "transactions:category-suggestions-apply");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonBadRequest("Request body must be JSON.");
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return jsonBadRequest(parsed.error.issues[0]?.message ?? "Invalid request body.");

  try {
    let updated = 0;
    for (const { transactionId, categoryId } of parsed.data.choices) {
      const row = await updateTransactionCategory(user.id, transactionId, categoryId);
      if (row) updated += 1;
    }
    const skipped = parsed.data.choices.length - updated;
    const rules = await createRulesFromSuggestions(user.id, parsed.data.rules ?? []);

    if (updated > 0 || rules.created > 0) {
      await recordAuditLog(user.id, {
        action: "UPDATE",
        entityType: "NotableTransaction",
        entityId: "bulk:ai-category-suggestions",
        afterData: { updatedCount: updated, rulesCreated: rules.created },
      });
    }
    return NextResponse.json({ ok: true, updated, skipped, rulesCreated: rules.created, rulesSkipped: rules.skipped });
  } catch (error) {
    console.error("POST /api/transactions/category-suggestions/apply failed", error);
    return jsonServerError();
  }
}
