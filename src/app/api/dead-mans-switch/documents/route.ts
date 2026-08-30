import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonServerError } from "../../../../server/api/responses";
import { DocumentTitleSchema, VaultCiphertextSchema } from "../../../../server/api/dead-mans-switch-validation";
import { recordAuditLog } from "../../../../server/dal/audit-log";
import { addDocument } from "../../../../server/dal/dead-mans-switch";

const BodySchema = z.object({ title: DocumentTitleSchema, ciphertext: VaultCiphertextSchema });

/**
 * Adds an Emergency Vault document after initial setup (AGENTS.md §3t).
 * Unlike beneficiaries/share config, documents CAN be added any time the
 * vault is unlocked in the browser — they reuse the already-established
 * master key rather than requiring a re-split.
 */
export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "dead-mans-switch:add-document");
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
    const result = await addDocument(user.id, parsed.data.title, parsed.data.ciphertext);
    if (!result.ok) {
      return jsonBadRequest("Set up the Dead Man's Switch vault before adding documents");
    }

    // Same reasoning as setup's audit entry — the title is user-chosen
    // free text about a sensitive document; the ciphertext is opaque.
    // Neither belongs in an audit record.
    await recordAuditLog(user.id, { entityType: "EmergencyDocument", entityId: result.id, action: "CREATE" });

    return NextResponse.json({ ok: true, id: result.id }, { status: 201 });
  } catch (error) {
    console.error("POST /api/dead-mans-switch/documents failed", error);
    return jsonServerError();
  }
}
