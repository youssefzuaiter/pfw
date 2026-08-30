import { NextResponse, type NextRequest } from "next/server";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonNotFound, jsonServerError } from "../../../../server/api/responses";
import { recordAuditLog } from "../../../../server/dal/audit-log";
import { deleteCryptoWallet } from "../../../../server/dal/crypto-wallets";

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardMutation(request, "crypto-wallets:delete");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  const { id: walletId } = await params;

  try {
    const result = await deleteCryptoWallet(user.id, walletId);
    if (!result.ok) return jsonNotFound();

    await recordAuditLog(user.id, { entityType: "CryptoWallet", entityId: walletId, action: "DELETE" });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("DELETE /api/crypto-wallets/[id] failed", error);
    return jsonServerError();
  }
}
