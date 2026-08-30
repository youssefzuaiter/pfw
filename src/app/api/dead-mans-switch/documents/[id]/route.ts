import { NextResponse, type NextRequest } from "next/server";
import { guardMutation } from "../../../../../server/api/guard-mutation";
import { jsonNotFound, jsonServerError } from "../../../../../server/api/responses";
import { recordAuditLog } from "../../../../../server/dal/audit-log";
import { deleteDocument } from "../../../../../server/dal/dead-mans-switch";

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardMutation(request, "dead-mans-switch:delete-document");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  const { id: documentId } = await params;

  try {
    const result = await deleteDocument(user.id, documentId);
    if (!result.ok) return jsonNotFound();

    await recordAuditLog(user.id, { entityType: "EmergencyDocument", entityId: documentId, action: "DELETE" });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("DELETE /api/dead-mans-switch/documents/[id] failed", error);
    return jsonServerError();
  }
}
