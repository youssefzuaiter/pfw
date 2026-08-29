import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { guardMutation } from "../../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonNotFound, jsonServerError } from "../../../../../server/api/responses";
import { ZkCiphertextSchema } from "../../../../../server/api/zk-validation";
import { recordAuditLog } from "../../../../../server/dal/audit-log";
import { updateGoalContributionNote } from "../../../../../server/dal/goals";

const BodySchema = z.object({ note: ZkCiphertextSchema });

/**
 * Overwrites one contribution's note with a new zero-knowledge ciphertext
 * blob. The only caller today is the vault-setup migration flow, re-
 * encrypting a legacy note under the user's new key (AGENTS.md §3m) —
 * `note` must already be a "zk1:..." blob; the server never sees, and
 * this route never accepts, plaintext.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardMutation(request, "goals:contribution-note");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  const { id: contributionId } = await params;

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

  try {
    const updated = await updateGoalContributionNote(user.id, contributionId, parsed.data.note);
    if (!updated) return jsonNotFound();

    // The ciphertext itself is opaque to the server, but it's still not
    // audit-log material — same reasoning as the trades/transactions
    // audit entries never carrying the encrypted field's raw bytes.
    await recordAuditLog(user.id, {
      entityType: "GoalContribution",
      entityId: updated.id,
      action: "UPDATE",
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("PATCH /api/goals/contributions/[id] failed", error);
    return jsonServerError();
  }
}
