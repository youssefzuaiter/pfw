import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonNotFound, jsonServerError } from "../../../../server/api/responses";
import { checkTotpChallenge, verifyCredentials } from "../../../../server/auth/credentials";
import { deleteAccount } from "../../../../server/account/delete-account";
import { whyAccountCannotBeDeleted } from "../../../../server/account/protected-accounts";

/**
 * POST /api/account/delete — permanently deletes the signed-in account
 * (AGENTS.md §3ttt).
 *
 * A live session is not enough on its own: a stolen cookie must not be able
 * to erase an account. The request has to carry the current password, a
 * TOTP code when two-factor sign-in is on, and the word DELETE. A wrong
 * password counts toward the account lockout like a failed sign-in, and the
 * route allows five attempts an hour.
 *
 * No audit entry is written: the user's audit log is deleted with
 * everything else. AccountDeletionRecord keeps the id and the date.
 */
const RATE_LIMIT = { windowMs: 60 * 60 * 1000, maxRequests: 5 };

const BodySchema = z.object({
  password: z.string().min(1).max(1024),
  totpCode: z.string().trim().max(16).optional(),
  confirm: z.literal("DELETE"),
});

export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "account:delete", RATE_LIMIT);
  if ("response" in guard) return guard.response;
  const { user } = guard;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonBadRequest("Invalid JSON body");
  }
  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return jsonBadRequest("Enter your password and type DELETE to confirm", parsed.error.issues);
  }

  try {
    const blocked = await whyAccountCannotBeDeleted(user);
    if (blocked) {
      return NextResponse.json({ error: blocked, code: "protected_account" }, { status: 409 });
    }

    const verification = await verifyCredentials(user.email, parsed.data.password);
    if (verification.outcome !== "valid" || verification.user.id !== user.id) {
      return NextResponse.json({ error: "Incorrect password", code: "invalid_password" }, { status: 400 });
    }

    const totp = await checkTotpChallenge(user.id, parsed.data.totpCode || undefined);
    if (totp === "required") {
      return NextResponse.json({ error: "Enter the code from your authenticator app", code: "totp_required" }, { status: 400 });
    }
    if (totp === "invalid") {
      return NextResponse.json({ error: "That code is not valid", code: "totp_invalid" }, { status: 400 });
    }

    const result = await deleteAccount(user.id);
    if (!result.ok && result.error === "not_found") return jsonNotFound();
    if (!result.ok) {
      console.error(`POST /api/account/delete refused: other users' rows reference this account (${result.references.join(", ")})`);
      return NextResponse.json(
        { error: "This account's data is linked to another account, so it was not deleted. Nothing was changed.", code: "cross_tenant_reference" },
        { status: 409 },
      );
    }

    return NextResponse.json({ deleted: true });
  } catch (error) {
    console.error("POST /api/account/delete failed", error);
    return jsonServerError();
  }
}
