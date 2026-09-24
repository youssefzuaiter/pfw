import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { guardMutation } from "../../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonServerError } from "../../../../../server/api/responses";
import { recordAuditLog } from "../../../../../server/dal/audit-log";
import { applyRulesToExistingTransactions } from "../../../../../server/dal/transactions";

const BodySchema = z.object({
  /** Preview only — returns what would change and writes nothing. */
  dryRun: z.boolean().default(true),
});

/** How many changed rows to show in a preview before summarising the rest. */
const PREVIEW_LIMIT = 25;

/**
 * Runs the user's Tier-0 rules over transactions already stored.
 *
 * Rules otherwise only fire at import, manual entry and sync, so writing
 * one did nothing for what was already there. `dryRun` defaults to TRUE:
 * this can rewrite hundreds of rows and categorisation has no undo, so
 * the destructive direction has to be asked for explicitly.
 */
export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "transactions:apply-rules");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // An empty body is fine — it means the safe default, a dry run.
  }

  const parsed = BodySchema.safeParse(body ?? {});
  if (!parsed.success) return jsonBadRequest(parsed.error.issues[0]?.message ?? "Invalid request body.");

  try {
    const result = await applyRulesToExistingTransactions(user.id, {
      dryRun: parsed.data.dryRun,
      limit: PREVIEW_LIMIT,
    });

    if (!parsed.data.dryRun && result.updatedCount > 0) {
      await recordAuditLog(user.id, {
        action: "UPDATE",
        entityType: "NotableTransaction",
        entityId: "bulk:apply-rules",
        afterData: { updatedCount: result.updatedCount },
      });
    }

    return NextResponse.json({
      ok: true,
      dryRun: parsed.data.dryRun,
      totalChanges: result.totalChanges,
      updatedCount: result.updatedCount,
      alreadyCorrect: result.alreadyCorrect,
      protectedByManualChoice: result.protectedByManualChoice,
      changes: result.changes.map((change) => ({
        ...change,
        occurredAt: change.occurredAt.toISOString().slice(0, 10),
      })),
    });
  } catch (error) {
    console.error("apply rules to existing failed", error);
    return jsonServerError();
  }
}
