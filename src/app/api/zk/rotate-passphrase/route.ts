import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonServerError } from "../../../../server/api/responses";
import { ZkCiphertextSchema, ZkIterationsSchema, ZkSaltSchema } from "../../../../server/api/zk-validation";
import { recordAuditLog } from "../../../../server/dal/audit-log";
import { rotateZkVaultPassphrase } from "../../../../server/dal/zk-vault";

const NoteIdSchema = z.string().min(1).max(64);

const BodySchema = z.object({
  newSalt: ZkSaltSchema,
  newIterations: ZkIterationsSchema,
  newCanaryCiphertext: ZkCiphertextSchema,
  reencryptedNotes: z.array(z.object({ id: NoteIdSchema, note: ZkCiphertextSchema })).max(10_000),
});

/**
 * Passphrase Rotation for the zero-knowledge goal-notes vault (AGENTS.md
 * §3m amendment). Everything in the body is produced client-side by
 * `zkVaultRotate` (`src/lib/workers/zk-vault-worker-client.ts`) — the OLD
 * passphrase is verified against the caller's OWN currently-stored
 * canary entirely inside the Web Worker before this route is ever
 * called; this route only ever sees the NEW (non-secret)
 * salt/iterations/canary and already-re-encrypted note ciphertext blobs,
 * never a passphrase or a key in either direction.
 *
 * "not_set_up" (rotating a vault that was never set up) and
 * "notes_changed_concurrently" (a note was added/edited between the
 * client's fetch and this write — see `rotateZkVaultPassphrase`'s DAL
 * doc comment) both come back as 400s: both are "retry from scratch"
 * conditions the client can recover from, not IDOR/not-found cases.
 */
export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "zk:rotate-passphrase");
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
    const result = await rotateZkVaultPassphrase(user.id, {
      newSalt: parsed.data.newSalt,
      newIterations: parsed.data.newIterations,
      newCanaryCiphertext: parsed.data.newCanaryCiphertext,
      reencryptedNotes: parsed.data.reencryptedNotes,
    });

    if (!result.ok) {
      return jsonBadRequest(
        result.error === "not_set_up"
          ? "Set up the zero-knowledge vault before rotating its passphrase"
          : "Your notes changed since this rotation started — reload and try again",
      );
    }

    // Same reasoning as /api/zk/setup's audit entry — none of these
    // values are secret, but there is no legitimate reason for an audit
    // record to carry cryptographic material either.
    await recordAuditLog(user.id, { entityType: "ZkVault", entityId: user.id, action: "UPDATE" });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("POST /api/zk/rotate-passphrase failed", error);
    return jsonServerError();
  }
}
