import { NextResponse, type NextRequest } from "next/server";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonServerError } from "../../../../server/api/responses";
import { UpdateVaultBeneficiariesBodySchema } from "../../../../server/api/dead-mans-switch-validation";
import { recordAuditLog } from "../../../../server/dal/audit-log";
import { updateVaultBeneficiaries } from "../../../../server/dal/dead-mans-switch";

const ERROR_MESSAGES: Record<string, string> = {
  not_set_up: "Set up the Emergency Vault before managing beneficiaries",
  not_active: "Cancel any in-progress recovery before changing beneficiaries",
  beneficiary_count_mismatch: "beneficiaries.length must equal totalShares",
};

/**
 * Dynamic Beneficiaries (AGENTS.md §3t amendment, item 2) — replaces the
 * ENTIRE beneficiary roster in one call, re-splitting the existing
 * master key at a new total/threshold configuration. Everything in the
 * body is produced client-side by `dmsVaultResplit`
 * (`src/lib/workers/dead-mans-switch-worker-client.ts`), which itself
 * requires the owner's CURRENT passphrase to re-derive the master key
 * (see that function's own doc comment for why) — this route never sees
 * a passphrase, only the new share configuration and each beneficiary's
 * label/share-index/share-hash/invite-token-hash.
 */
export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "dead-mans-switch:beneficiaries");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonBadRequest("Request body must be valid JSON");
  }

  const parsed = UpdateVaultBeneficiariesBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return jsonBadRequest("Invalid request body", parsed.error.issues);
  }

  try {
    const result = await updateVaultBeneficiaries(user.id, parsed.data);
    if (!result.ok) {
      return jsonBadRequest(ERROR_MESSAGES[result.error]);
    }

    await recordAuditLog(user.id, { entityType: "DeadMansSwitch", entityId: user.id, action: "UPDATE" });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("POST /api/dead-mans-switch/beneficiaries failed", error);
    return jsonServerError();
  }
}
