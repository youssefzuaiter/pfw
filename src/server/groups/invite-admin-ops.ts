import "server-only";
import { createAdminClient } from "../db/admin-client";

/**
 * The one deliberate, narrowly-scoped admin-client exception for the
 * Household Spaces feature (AGENTS.md §3s) — isolated into its own file,
 * exactly two functions, so the security boundary is easy to audit and
 * to allowlist in `tests/guards/admin-client-boundary.test.ts`.
 *
 * Why this needs the admin client at all: `GroupInvite` RLS is
 * creator-only (see the migration). The user *accepting* an invite is,
 * by definition, neither the invite's creator nor yet a group member, so
 * they have no row-level standing to SELECT the invite by its token hash
 * or to mark it ACCEPTED. Same class of bootstrap problem
 * `getCurrentUser()` solves for identity resolution, and the same
 * "documented, narrowly-scoped, one-time" shape as the zero-knowledge
 * vault's legacy-note migration (AGENTS.md §3m) — never a general
 * RLS-bypass convenience.
 *
 * Everything else in the invite/accept flow (creating the invite,
 * inserting the accepting user's own `GroupMember` row) goes through the
 * normal `withUserScope`-scoped path in `src/server/dal/shared-groups.ts`
 * and is fully RLS-covered.
 */

export async function adminFindInviteByTokenHash(tokenHash: string) {
  const admin = createAdminClient();
  return admin.groupInvite.findUnique({ where: { tokenHash }, include: { sharedGroup: true } });
}

export async function adminMarkInviteAccepted(inviteId: string, acceptedById: string) {
  const admin = createAdminClient();
  return admin.groupInvite.update({
    where: { id: inviteId },
    data: { status: "ACCEPTED", acceptedById },
  });
}

/** Lazily flips a still-PENDING invite to EXPIRED once its `expiresAt` has passed — see `acceptGroupInvite`'s doc comment for why this happens at accept-time rather than via a background sweep. */
export async function adminMarkInviteExpired(inviteId: string) {
  const admin = createAdminClient();
  return admin.groupInvite.update({ where: { id: inviteId }, data: { status: "EXPIRED" } });
}
