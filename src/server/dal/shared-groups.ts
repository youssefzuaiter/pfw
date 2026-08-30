import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { withUserScope } from "../db/with-user-scope";
import { adminFindInviteByTokenHash, adminMarkInviteAccepted, adminMarkInviteExpired } from "../groups/invite-admin-ops";

const DEFAULT_INVITE_EXPIRY_DAYS = 7;
const RAW_TOKEN_BYTES = 32;

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

// === Groups & membership =====================================================

/**
 * Creates a SharedGroup and, in the same transaction, the creator's own
 * OWNER/WRITE `GroupMember` row — the one case where the "membership is
 * only ever created by self-insert" rule (GroupMember's model comment)
 * is exercised directly rather than via an accepted invite.
 */
export async function createSharedGroup(userId: string, name: string) {
  return withUserScope(userId, async (tx) => {
    const group = await tx.sharedGroup.create({ data: { name, createdById: userId } });
    await tx.groupMember.create({
      data: { sharedGroupId: group.id, userId, role: "OWNER", permission: "WRITE" },
    });
    return group;
  });
}

/** Every group the user belongs to (owner or member), with their own membership row alongside each. */
export async function listMyGroups(userId: string) {
  const memberships = await withUserScope(userId, (tx) =>
    tx.groupMember.findMany({
      where: { userId },
      include: { sharedGroup: true },
      orderBy: { joinedAt: "asc" },
    }),
  );
  return memberships.map((m) => ({ group: m.sharedGroup, membership: m }));
}

/** The caller's own membership row for a group, or `null` if they aren't a member — the standard permission-check primitive every group-scoped mutation uses. */
export async function getMyMembership(userId: string, sharedGroupId: string) {
  return withUserScope(userId, (tx) =>
    tx.groupMember.findFirst({ where: { sharedGroupId, userId } }),
  );
}

/**
 * The full member roster for a group — visible to any fellow member, not
 * just the owner (GroupMember's SELECT policy — see the migration's
 * "team roster visible to every teammate" comment). Also what makes each
 * row's included `user.displayName` resolve at all: `User`'s own SELECT
 * policy was extended specifically so a fellow group member's basic
 * identity is visible, which a Prisma relational `include` needs in
 * order to not silently come back `null` (a real bug this shipped with
 * initially and fixed — see the migration's "User: extend SELECT" note).
 */
export async function listGroupMembers(userId: string, sharedGroupId: string) {
  return withUserScope(userId, (tx) =>
    tx.groupMember.findMany({
      where: { sharedGroupId },
      include: { user: { select: { id: true, displayName: true, email: true } } },
      orderBy: { joinedAt: "asc" },
    }),
  );
}

export type UpdateMemberResult = { ok: true } | { ok: false; error: "not_owner" | "member_not_found" | "cannot_edit_owner" };

/** Only the group's creator may change a member's permission — see the migration's GroupMember UPDATE policy for why there's no self-service path (privilege-escalation risk). */
export async function updateMemberPermission(
  ownerUserId: string,
  sharedGroupId: string,
  memberUserId: string,
  permission: "READ" | "WRITE",
): Promise<UpdateMemberResult> {
  return withUserScope(ownerUserId, async (tx) => {
    const group = await tx.sharedGroup.findFirst({ where: { id: sharedGroupId, createdById: ownerUserId } });
    if (!group) return { ok: false, error: "not_owner" };

    const member = await tx.groupMember.findFirst({ where: { sharedGroupId, userId: memberUserId } });
    if (!member) return { ok: false, error: "member_not_found" };
    if (member.role === "OWNER") return { ok: false, error: "cannot_edit_owner" };

    await tx.groupMember.update({ where: { id: member.id }, data: { permission } });
    return { ok: true };
  });
}

export type RemoveMemberResult = { ok: true } | { ok: false; error: "not_found" | "cannot_remove_owner" };

/** Self-leave (`actingUserId === memberUserId`) or the group owner removing someone else — both satisfied by the migration's GroupMember DELETE policy. */
export async function removeMember(
  actingUserId: string,
  sharedGroupId: string,
  memberUserId: string,
): Promise<RemoveMemberResult> {
  return withUserScope(actingUserId, async (tx) => {
    const member = await tx.groupMember.findFirst({ where: { sharedGroupId, userId: memberUserId } });
    if (!member) return { ok: false, error: "not_found" };
    if (member.role === "OWNER") return { ok: false, error: "cannot_remove_owner" };

    await tx.groupMember.delete({ where: { id: member.id } });
    return { ok: true };
  });
}

// === Invitations ==============================================================

export type CreateInviteResult =
  | { ok: true; invite: { id: string; invitedEmail: string; permission: "READ" | "WRITE"; expiresAt: Date }; rawToken: string }
  | { ok: false; error: "not_owner" };

/**
 * Generates a single-use invite token, returned to the caller exactly
 * once — only its SHA-256 hash is persisted (`GroupInvite.tokenHash`),
 * the same "hash it, never store the secret" treatment described in the
 * model's doc comment. Requires the caller to already be the group's
 * OWNER — this is the *only* path that can ever add a new member (there
 * is no direct "owner adds userId X" function), matching the task's own
 * "inviting members via secure tokens" framing.
 */
export async function createGroupInvite(
  ownerUserId: string,
  sharedGroupId: string,
  invitedEmail: string,
  permission: "READ" | "WRITE",
  expiresInDays: number = DEFAULT_INVITE_EXPIRY_DAYS,
): Promise<CreateInviteResult> {
  return withUserScope(ownerUserId, async (tx) => {
    const membership = await tx.groupMember.findFirst({ where: { sharedGroupId, userId: ownerUserId } });
    if (!membership || membership.role !== "OWNER") return { ok: false, error: "not_owner" };

    const rawToken = randomBytes(RAW_TOKEN_BYTES).toString("base64url");
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

    const invite = await tx.groupInvite.create({
      data: { sharedGroupId, invitedEmail, tokenHash, permission, expiresAt, createdById: ownerUserId },
    });

    return {
      ok: true,
      invite: { id: invite.id, invitedEmail: invite.invitedEmail, permission: invite.permission, expiresAt: invite.expiresAt },
      rawToken,
    };
  });
}

/** The owner's own pending/past invites for a group — RLS (creator-only) already scopes this; the explicit `where` is defense-in-depth, same belt-and-braces pattern as everywhere else in the DAL. */
export async function listGroupInvites(ownerUserId: string, sharedGroupId: string) {
  return withUserScope(ownerUserId, (tx) =>
    tx.groupInvite.findMany({ where: { sharedGroupId, createdById: ownerUserId }, orderBy: { createdAt: "desc" } }),
  );
}

export type RevokeInviteResult = { ok: true } | { ok: false; error: "not_found" | "not_pending" };

export async function revokeGroupInvite(ownerUserId: string, inviteId: string): Promise<RevokeInviteResult> {
  return withUserScope(ownerUserId, async (tx) => {
    const invite = await tx.groupInvite.findFirst({ where: { id: inviteId, createdById: ownerUserId } });
    if (!invite) return { ok: false, error: "not_found" };
    if (invite.status !== "PENDING") return { ok: false, error: "not_pending" };

    await tx.groupInvite.update({ where: { id: inviteId }, data: { status: "REVOKED" } });
    return { ok: true };
  });
}

export type AcceptInviteResult =
  | { ok: true; sharedGroupId: string }
  | { ok: false; error: "invalid_token" | "already_used" | "expired" | "already_member" };

/**
 * Accepts an invite by its raw token. Two admin-client calls bracket an
 * otherwise fully RLS-scoped operation — see `invite-admin-ops.ts`'s doc
 * comment for why those two specific steps need it (the accepting user
 * has no row-level standing on `GroupInvite` until after this function
 * runs). Expiry is checked and applied lazily here, at accept time,
 * rather than by a background sweep — nothing in this app runs scheduled
 * jobs (Section 6's cost/DoS backstop is the closest precedent, and it's
 * still purely request-driven), so "is `expiresAt` in the past" is
 * simply evaluated against `now` whenever an accept attempt actually
 * happens, which is the only moment the distinction is ever load-bearing.
 */
export async function acceptGroupInvite(acceptingUserId: string, rawToken: string): Promise<AcceptInviteResult> {
  const tokenHash = hashToken(rawToken);
  const invite = await adminFindInviteByTokenHash(tokenHash);
  if (!invite) return { ok: false, error: "invalid_token" };

  if (invite.status === "ACCEPTED" || invite.status === "REVOKED") {
    return { ok: false, error: "already_used" };
  }
  if (invite.status === "EXPIRED" || invite.expiresAt.getTime() < Date.now()) {
    if (invite.status !== "EXPIRED") await adminMarkInviteExpired(invite.id);
    return { ok: false, error: "expired" };
  }

  const existingMembership = await withUserScope(acceptingUserId, (tx) =>
    tx.groupMember.findFirst({ where: { sharedGroupId: invite.sharedGroupId, userId: acceptingUserId } }),
  );
  if (existingMembership) return { ok: false, error: "already_member" };

  await withUserScope(acceptingUserId, (tx) =>
    tx.groupMember.create({
      data: {
        sharedGroupId: invite.sharedGroupId,
        userId: acceptingUserId,
        role: "MEMBER",
        permission: invite.permission,
      },
    }),
  );

  await adminMarkInviteAccepted(invite.id, acceptingUserId);

  return { ok: true, sharedGroupId: invite.sharedGroupId };
}

// === Sharing a resource into (or out of) a group =============================

export type ShareableResourceType = "budget" | "bankAccount" | "category";

export type SetResourceSharingResult =
  | { ok: true }
  | { ok: false; error: "resource_not_found" | "not_group_member" };

/**
 * The primary control (AGENTS.md's DAL-first, RLS-defense-in-depth
 * split, §3a) for setting or clearing a resource's `sharedGroupId`:
 * verifies the caller actually owns the resource AND — this is the part
 * RLS alone can't fully close, see the migration's own comment — that
 * they belong to the target group at all before ever pointing their own
 * resource at it. Passing `sharedGroupId: null` un-shares it; that
 * direction needs no group-membership check at all.
 *
 * Deliberately just "is a member," not "has WRITE" — sharing YOUR OWN
 * resource into a group you belong to isn't "editing someone else's
 * data," so it isn't gated behind the WRITE permission the way editing a
 * fellow member's shared resource is (see the migration's `update_scope`
 * policies on Budget/BankAccount/Category for that distinction enforced
 * at the RLS layer too).
 *
 * Ownership is checked BEFORE group membership, deliberately — this is
 * what makes the IDOR case ("you don't own this resourceId at all," a
 * caller has no legitimate business asking about) always come back
 * `resource_not_found` regardless of what they claimed as the target
 * group, rather than sometimes leaking "not_group_member" first for a
 * resourceId that was never theirs to begin with. `not_group_member` is
 * therefore only ever returned to a caller who *does* own the resource
 * (its ownership check already passed) but picked a group they don't
 * belong to.
 */
export async function setResourceSharing(
  userId: string,
  resourceType: ShareableResourceType,
  resourceId: string,
  sharedGroupId: string | null,
): Promise<SetResourceSharingResult> {
  return withUserScope(userId, async (tx) => {
    switch (resourceType) {
      case "budget": {
        const existing = await tx.budget.findFirst({ where: { id: resourceId, userId } });
        if (!existing) return { ok: false, error: "resource_not_found" };
        if (sharedGroupId !== null) {
          const membership = await tx.groupMember.findFirst({ where: { sharedGroupId, userId } });
          if (!membership) return { ok: false, error: "not_group_member" };
        }
        await tx.budget.update({ where: { id: resourceId }, data: { sharedGroupId } });
        return { ok: true };
      }
      case "bankAccount": {
        const existing = await tx.bankAccount.findFirst({ where: { id: resourceId, userId } });
        if (!existing) return { ok: false, error: "resource_not_found" };
        if (sharedGroupId !== null) {
          const membership = await tx.groupMember.findFirst({ where: { sharedGroupId, userId } });
          if (!membership) return { ok: false, error: "not_group_member" };
        }
        await tx.bankAccount.update({ where: { id: resourceId }, data: { sharedGroupId } });
        return { ok: true };
      }
      case "category": {
        const existing = await tx.category.findFirst({ where: { id: resourceId, userId } });
        if (!existing) return { ok: false, error: "resource_not_found" };
        if (sharedGroupId !== null) {
          const membership = await tx.groupMember.findFirst({ where: { sharedGroupId, userId } });
          if (!membership) return { ok: false, error: "not_group_member" };
        }
        await tx.category.update({ where: { id: resourceId }, data: { sharedGroupId } });
        return { ok: true };
      }
    }
  });
}

// === Reading a group's pooled shared data =====================================

/**
 * Everything shared into one group, from every member who chose to
 * share something into it — this is what the "Household Spaces" toggle
 * (AGENTS.md §3s) renders. RLS's `select_scope` policies on all three
 * tables are what actually make another member's rows visible here at
 * all; the explicit `sharedGroupId` filter below is the same
 * defense-in-depth belt-and-braces the rest of the DAL already applies
 * everywhere else.
 */
export async function getSharedGroupData(userId: string, sharedGroupId: string) {
  return withUserScope(userId, async (tx) => {
    const [budgets, bankAccounts, categories] = await Promise.all([
      tx.budget.findMany({
        where: { sharedGroupId },
        include: { category: true, user: { select: { id: true, displayName: true } } },
        orderBy: { category: { name: "asc" } },
      }),
      tx.bankAccount.findMany({
        where: { sharedGroupId },
        include: { user: { select: { id: true, displayName: true } } },
        orderBy: { createdAt: "asc" },
      }),
      tx.category.findMany({
        where: { sharedGroupId, archivedAt: null },
        include: { user: { select: { id: true, displayName: true } } },
        orderBy: { name: "asc" },
      }),
    ]);
    return { budgets, bankAccounts, categories };
  });
}
