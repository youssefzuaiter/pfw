import { NextResponse, type NextRequest } from "next/server";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonServerError } from "../../../../server/api/responses";
import { recordAuditLog } from "../../../../server/dal/audit-log";
import { cancelRecovery } from "../../../../server/dal/dead-mans-switch";

/**
 * The vault owner's "I'm alive" action during an active TRIGGERED
 * recovery (AGENTS.md §3t) — see `cancelRecovery`'s doc comment for why
 * this must be an explicit action rather than something a passive page
 * load auto-triggers.
 */
export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "dead-mans-switch:cancel-recovery");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  try {
    const result = await cancelRecovery(user.id);
    if (!result.ok) {
      return jsonBadRequest(
        result.error === "not_set_up" ? "Dead Man's Switch is not set up for this account" : "Recovery is not currently active",
      );
    }

    await recordAuditLog(user.id, { entityType: "DeadMansSwitch", entityId: user.id, action: "UPDATE" });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("POST /api/dead-mans-switch/cancel-recovery failed", error);
    return jsonServerError();
  }
}
