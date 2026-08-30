import { NextResponse, type NextRequest } from "next/server";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonServerError } from "../../../../server/api/responses";
import { SetupVaultBodySchema } from "../../../../server/api/dead-mans-switch-validation";
import { recordAuditLog } from "../../../../server/dal/audit-log";
import { setupVault } from "../../../../server/dal/dead-mans-switch";

/**
 * One-time Emergency Vault setup for the Cryptographic Dead Man's Switch
 * (AGENTS.md §3t). Everything in the body is produced client-side by
 * src/lib/shamir-secret-sharing.ts + src/lib/dead-mans-switch-crypto.ts:
 * the master key and every raw share are generated, split, and used to
 * encrypt every document in the browser, and never sent here — only the
 * salt/iterations/canary (non-secret, same treatment `/api/zk/setup`
 * gives the zero-knowledge vault), each beneficiary's share HASH and
 * invite-token HASH (never the raw share or raw token), and each
 * document's already-encrypted ciphertext. Rejects a second call
 * outright (`setupVault`'s "already_set_up" — see its doc comment for
 * why: the whole share set is tied to one specific polynomial split, and
 * there is no re-split/redistribute flow).
 */
export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "dead-mans-switch:setup");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonBadRequest("Request body must be valid JSON");
  }

  const parsed = SetupVaultBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return jsonBadRequest("Invalid request body", parsed.error.issues);
  }

  try {
    const result = await setupVault(user.id, parsed.data);
    if (!result.ok) {
      return jsonBadRequest(
        result.error === "already_set_up"
          ? "Dead Man's Switch is already set up for this account"
          : "Beneficiary count must exactly match totalShares",
      );
    }

    // Deliberately no salt/canary/share-hash/token-hash values in the
    // audit entry — none of these are secret, but there is no
    // legitimate reason for an audit record to carry cryptographic
    // material either (same reasoning /api/zk/setup's audit entry uses).
    await recordAuditLog(user.id, { entityType: "DeadMansSwitch", entityId: user.id, action: "CREATE" });

    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (error) {
    console.error("POST /api/dead-mans-switch/setup failed", error);
    return jsonServerError();
  }
}
