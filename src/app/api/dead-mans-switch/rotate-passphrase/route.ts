import { NextResponse, type NextRequest } from "next/server";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonServerError } from "../../../../server/api/responses";
import { RotateVaultPassphraseBodySchema } from "../../../../server/api/dead-mans-switch-validation";
import { recordAuditLog } from "../../../../server/dal/audit-log";
import { rotateVaultPassphrase } from "../../../../server/dal/dead-mans-switch";

const ERROR_MESSAGES: Record<string, string> = {
  not_set_up: "Set up the Emergency Vault before rotating its passphrase",
  not_active: "Cancel any in-progress recovery before rotating the passphrase",
  document_set_mismatch: "Your documents changed since this rotation started — reload and try again",
  beneficiary_set_mismatch: "Your beneficiaries changed since this rotation started — reload and try again",
};

/**
 * Passphrase Rotation, Emergency Vault half (AGENTS.md §3t amendment,
 * item 1). Everything in the body is produced client-side by
 * `dmsVaultRotate` (`src/lib/workers/dead-mans-switch-worker-client.ts`)
 * — the OLD passphrase is verified against the caller's own currently-
 * stored canary entirely inside the Web Worker before this route is ever
 * called; every document is decrypted-then-re-encrypted and the master
 * key re-split entirely inside that same worker call. This route only
 * ever sees the NEW (non-secret) salt/iterations/canary, already-re-
 * encrypted document ciphertext, and each beneficiary's NEW share
 * index/hash — never a passphrase, a key, or plaintext document content.
 */
export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "dead-mans-switch:rotate-passphrase");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonBadRequest("Request body must be valid JSON");
  }

  const parsed = RotateVaultPassphraseBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return jsonBadRequest("Invalid request body", parsed.error.issues);
  }

  try {
    const result = await rotateVaultPassphrase(user.id, parsed.data);
    if (!result.ok) {
      return jsonBadRequest(ERROR_MESSAGES[result.error]);
    }

    // No cryptographic material in the audit entry, same reasoning as
    // /api/dead-mans-switch/setup's audit entry.
    await recordAuditLog(user.id, { entityType: "DeadMansSwitch", entityId: user.id, action: "UPDATE" });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("POST /api/dead-mans-switch/rotate-passphrase failed", error);
    return jsonServerError();
  }
}
