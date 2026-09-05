import "server-only";
import { createAdminClient } from "../db/admin-client";

/**
 * MFA backup-code redemption (Phase 3, Security & Recovery) — the
 * SIXTH narrow, allowlisted admin-client bootstrap exception, same
 * justification every prior one shares (`current-user.ts`, the
 * household/vault invite flows, `credentials.ts`,
 * `account-recovery-admin-ops.ts`, `webauthn-admin-ops.ts`): redeeming a
 * recovery code is, like a passkey sign-in, by definition unauthenticated
 * — there is no `userId` yet to scope a normal `withUserScope` call by
 * until the code has been verified. See
 * tests/guards/admin-client-boundary.test.ts.
 */

/**
 * Scoped to BOTH the caller-supplied userId AND the code's hash — never a
 * bare global lookup by hash alone, even though `codeHash` is globally
 * unique in the schema (the same "don't lean on incidental uniqueness"
 * discipline `findAuthenticatorForVerification`'s own doc comment
 * documents for `credentialId`). The "recovery-code" Credentials provider
 * (auth.ts) resolves the userId from the submitted email first, so a
 * user who mistakenly pastes a code belonging to a DIFFERENT account
 * paired with their own email fails here rather than silently succeeding
 * against the wrong account.
 */
export async function adminFindUnusedRecoveryCode(userId: string, codeHash: string) {
  const admin = createAdminClient();
  return admin.recoveryCode.findFirst({ where: { userId, codeHash, used: false } });
}

export async function adminMarkRecoveryCodeUsed(id: string): Promise<void> {
  const admin = createAdminClient();
  await admin.recoveryCode.update({ where: { id }, data: { used: true } });
}
