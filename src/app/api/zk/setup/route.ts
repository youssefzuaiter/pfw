import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonServerError } from "../../../../server/api/responses";
import { ZkCiphertextSchema, ZkIterationsSchema, ZkSaltSchema } from "../../../../server/api/zk-validation";
import { recordAuditLog } from "../../../../server/dal/audit-log";
import { setupZkVault } from "../../../../server/dal/zk-vault";

const BodySchema = z.object({
  salt: ZkSaltSchema,
  iterations: ZkIterationsSchema,
  canaryCiphertext: ZkCiphertextSchema,
});

/**
 * One-time zero-knowledge vault setup for `GoalContribution.note`
 * (AGENTS.md §3m). Everything in the body is produced client-side by
 * `src/lib/zk-crypto.ts` — a passphrase, and the key derived from it,
 * never appear in this request or anywhere else on the server. Rejects a
 * second call outright (`setupZkVault`'s "already_set_up" — see its doc
 * comment for why overwriting would silently orphan existing notes).
 */
export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "zk:setup");
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

  try {
    const result = await setupZkVault(user.id, parsed.data);
    if (!result.ok) {
      return jsonBadRequest("Zero-knowledge vault is already set up for this account");
    }

    // Deliberately no salt/canary/iteration values in the audit entry —
    // none of them are secret, but there is no legitimate reason for an
    // audit record to carry cryptographic material either.
    await recordAuditLog(user.id, { entityType: "ZkVault", entityId: user.id, action: "CREATE" });

    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (error) {
    console.error("POST /api/zk/setup failed", error);
    return jsonServerError();
  }
}
