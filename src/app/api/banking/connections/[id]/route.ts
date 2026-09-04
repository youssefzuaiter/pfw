import { NextResponse, type NextRequest } from "next/server";
import { guardMutation } from "../../../../../server/api/guard-mutation";
import { jsonNotFound } from "../../../../../server/api/responses";
import { unlinkBankConnection } from "../../../../../server/dal/bank-connections";

/** Unlinks a connection — deletes only the `BankConnection` row (`unlinkBankConnection`'s own doc comment: already-synced transaction history is deliberately left intact). "Not found" covers both "doesn't exist" and "belongs to someone else" (Section 2.2). */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardMutation(request, "banking:connections:delete");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  const { id } = await params;
  const unlinked = await unlinkBankConnection(user.id, id);
  if (!unlinked) return jsonNotFound();

  return NextResponse.json({ ok: true });
}
