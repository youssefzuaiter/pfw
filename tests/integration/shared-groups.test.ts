import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import { withUserScope } from "../../src/server/db/with-user-scope";
import { getBudgetById } from "../../src/server/dal/budgets";
import { getTransactionById } from "../../src/server/dal/transactions";
import {
  acceptGroupInvite,
  createGroupInvite,
  createSharedGroup,
  deleteSharedGroup,
  getMyMembership,
  getSharedGroupData,
  listMyGroups,
  removeMember,
  renameSharedGroup,
  setResourceSharing,
  transferGroupOwnership,
  updateMemberPermission,
} from "../../src/server/dal/shared-groups";

/**
 * Rigorous IDOR/RLS coverage for Granular Household & Shared Budget
 * Spaces (AGENTS.md §3s), same convention as tests/integration/idor.test.ts
 * and subscription-tracking.test.ts: real users, a real Postgres with RLS
 * active, exercising both the DAL's own checks AND the raw RLS policies
 * underneath them — several tests here deliberately bypass the DAL's own
 * business-logic functions and issue a raw `withUserScope`-scoped Prisma
 * call instead, specifically to prove the database-level policy itself
 * rejects an operation, not merely that no DAL function happens to expose
 * a way to attempt it.
 *
 * Skipped when APP_DATABASE_URL/DATABASE_URL aren't set, same convention
 * as every other integration test in this suite.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)(
  "Household Spaces: RLS + IDOR",
  () => {
    let admin: ReturnType<typeof createAdminClient>;

    let owner: { id: string };
    let memberWrite: { id: string };
    let memberRead: { id: string };
    let stranger: { id: string };

    let ownerBudgetId: string;
    let ownerBankAccountId: string;
    let ownerTransactionId: string;

    let groupId: string;

    beforeAll(async () => {
      admin = createAdminClient();
      const suffix = Date.now();
      owner = await admin.user.create({ data: { email: `hh-owner-${suffix}@pfw.local`, displayName: "Household Owner" } });
      memberWrite = await admin.user.create({ data: { email: `hh-write-${suffix}@pfw.local`, displayName: "Write Member" } });
      memberRead = await admin.user.create({ data: { email: `hh-read-${suffix}@pfw.local`, displayName: "Read Member" } });
      stranger = await admin.user.create({ data: { email: `hh-stranger-${suffix}@pfw.local`, displayName: "Stranger" } });

      const category = await admin.category.create({
        data: { userId: owner.id, slug: "uncategorized", name: "Uncategorized", isUncategorized: true },
      });

      const budget = await admin.budget.create({
        data: { userId: owner.id, categoryId: category.id, monthlyLimit: 100_000n },
      });
      ownerBudgetId = budget.id;

      const bankAccount = await admin.bankAccount.create({
        data: {
          userId: owner.id,
          institutionName: "Test Bank",
          last4: "1234",
          accountType: "CHECKING",
          nativeBalance: 500_000n,
        },
      });
      ownerBankAccountId = bankAccount.id;

      const transaction = await admin.notableTransaction.create({
        data: {
          userId: owner.id,
          bankAccountId: bankAccount.id,
          categoryId: category.id,
          occurredAt: new Date(),
          amount: -1_000n,
          nativeAmount: -1_000n,
          description: "Owner's private purchase",
        },
      });
      ownerTransactionId = transaction.id;

      const group = await createSharedGroup(owner.id, "Test Household");
      groupId = group.id;
    });

    afterAll(async () => {
      await admin.user.deleteMany({
        where: { id: { in: [owner.id, memberWrite.id, memberRead.id, stranger.id] } },
      });
      await admin.$disconnect();
    });

    describe("group creation & membership", () => {
      it("the creator becomes an OWNER/WRITE member automatically", async () => {
        const membership = await getMyMembership(owner.id, groupId);
        expect(membership).toMatchObject({ role: "OWNER", permission: "WRITE" });
      });

      it("a stranger has no membership at all", async () => {
        const membership = await getMyMembership(stranger.id, groupId);
        expect(membership).toBeNull();
      });

      it("listMyGroups includes the group for the owner but not for a stranger", async () => {
        const ownerGroups = await listMyGroups(owner.id);
        const strangerGroups = await listMyGroups(stranger.id);
        expect(ownerGroups.some((g) => g.group.id === groupId)).toBe(true);
        expect(strangerGroups.some((g) => g.group.id === groupId)).toBe(false);
      });
    });

    describe("invitations", () => {
      it("a non-owner cannot create an invite", async () => {
        const result = await createGroupInvite(stranger.id, groupId, "someone@example.com", "READ");
        expect(result).toEqual({ ok: false, error: "not_owner" });
      });

      it("the owner can create an invite; only its hash is persisted, never the raw token", async () => {
        const result = await createGroupInvite(owner.id, groupId, "write-invite@example.com", "WRITE");
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.rawToken.length).toBeGreaterThan(20);
        const stored = await admin.groupInvite.findUniqueOrThrow({ where: { id: result.invite.id } });
        expect(stored.tokenHash).not.toBe(result.rawToken);
        expect(stored.tokenHash).toHaveLength(64); // sha256 hex
      });

      it("accepting with a garbage token fails as invalid_token", async () => {
        const result = await acceptGroupInvite(memberWrite.id, "not-a-real-token");
        expect(result).toEqual({ ok: false, error: "invalid_token" });
      });

      it("accepting a valid token creates a GroupMember row with the invite's permission", async () => {
        const invite = await createGroupInvite(owner.id, groupId, "member-write@example.com", "WRITE");
        expect(invite.ok).toBe(true);
        if (!invite.ok) return;

        const result = await acceptGroupInvite(memberWrite.id, invite.rawToken);
        expect(result).toEqual({ ok: true, sharedGroupId: groupId });

        const membership = await getMyMembership(memberWrite.id, groupId);
        expect(membership).toMatchObject({ role: "MEMBER", permission: "WRITE" });
      });

      it("the same invite cannot be accepted twice", async () => {
        const invite = await createGroupInvite(owner.id, groupId, "second-accept@example.com", "READ");
        expect(invite.ok).toBe(true);
        if (!invite.ok) return;

        const first = await acceptGroupInvite(memberRead.id, invite.rawToken);
        expect(first).toEqual({ ok: true, sharedGroupId: groupId });

        const second = await acceptGroupInvite(stranger.id, invite.rawToken);
        expect(second).toEqual({ ok: false, error: "already_used" });
      });

      it("accepting an invite you're already a member from fails as already_member", async () => {
        const invite = await createGroupInvite(owner.id, groupId, "already-member@example.com", "READ");
        expect(invite.ok).toBe(true);
        if (!invite.ok) return;

        const result = await acceptGroupInvite(memberRead.id, invite.rawToken);
        expect(result).toEqual({ ok: false, error: "already_member" });
      });

      it("a revoked invite cannot be accepted", async () => {
        const invite = await createGroupInvite(owner.id, groupId, "revoke-me@example.com", "READ");
        expect(invite.ok).toBe(true);
        if (!invite.ok) return;

        await admin.groupInvite.update({ where: { id: invite.invite.id }, data: { status: "REVOKED" } });

        const result = await acceptGroupInvite(stranger.id, invite.rawToken);
        expect(result).toEqual({ ok: false, error: "already_used" });
      });

      it("an expired invite cannot be accepted and is lazily flipped to EXPIRED", async () => {
        const invite = await createGroupInvite(owner.id, groupId, "expired@example.com", "READ");
        expect(invite.ok).toBe(true);
        if (!invite.ok) return;

        await admin.groupInvite.update({
          where: { id: invite.invite.id },
          data: { expiresAt: new Date(Date.now() - 1000) },
        });

        const result = await acceptGroupInvite(stranger.id, invite.rawToken);
        expect(result).toEqual({ ok: false, error: "expired" });

        const stored = await admin.groupInvite.findUniqueOrThrow({ where: { id: invite.invite.id } });
        expect(stored.status).toBe("EXPIRED");
      });
    });

    describe("membership management & privilege-escalation resistance", () => {
      it("a non-owner cannot change anyone's permission (not_owner)", async () => {
        const result = await updateMemberPermission(memberWrite.id, groupId, memberRead.id, "WRITE");
        expect(result).toEqual({ ok: false, error: "not_owner" });
      });

      it("the owner CAN change a member's permission (positive control)", async () => {
        const result = await updateMemberPermission(owner.id, groupId, memberRead.id, "WRITE");
        expect(result).toEqual({ ok: true });

        const membership = await getMyMembership(memberRead.id, groupId);
        expect(membership?.permission).toBe("WRITE");

        // Reset for later tests that rely on memberRead being READ-only.
        await updateMemberPermission(owner.id, groupId, memberRead.id, "READ");
      });

      it("the owner's own row cannot be edited via this path", async () => {
        const result = await updateMemberPermission(owner.id, groupId, owner.id, "READ");
        expect(result).toEqual({ ok: false, error: "cannot_edit_owner" });
      });

      it("CRITICAL: a member cannot self-promote their own permission via a raw update — RLS rejects it even bypassing the DAL entirely", async () => {
        const myRow = await withUserScope(memberRead.id, (tx) =>
          tx.groupMember.findFirstOrThrow({ where: { sharedGroupId: groupId, userId: memberRead.id } }),
        );
        expect(myRow.permission).toBe("READ");

        // Attempt the update directly, bypassing updateMemberPermission's
        // own owner-only check entirely — this proves the RLS policy
        // itself (not just the DAL wrapper) blocks the escalation.
        await withUserScope(memberRead.id, (tx) =>
          tx.groupMember.updateMany({ where: { id: myRow.id }, data: { permission: "WRITE", role: "OWNER" } }),
        );

        const after = await admin.groupMember.findUniqueOrThrow({ where: { id: myRow.id } });
        expect(after.permission).toBe("READ");
        expect(after.role).toBe("MEMBER");
      });
    });

    describe("resource sharing & cross-group data leakage", () => {
      it("the owner can share their own budget into their own group", async () => {
        const result = await setResourceSharing(owner.id, "budget", ownerBudgetId, groupId);
        expect(result).toEqual({ ok: true });

        const budget = await getBudgetById(owner.id, ownerBudgetId);
        expect(budget?.sharedGroupId).toBe(groupId);
      });

      it("sharing into a group you don't belong to is rejected", async () => {
        const otherGroup = await createSharedGroup(stranger.id, "Stranger's Group");
        const result = await setResourceSharing(owner.id, "budget", ownerBudgetId, otherGroup.id);
        expect(result).toEqual({ ok: false, error: "not_group_member" });
      });

      it("sharing someone else's resource ID is an IDOR-safe not-found, never a permission leak", async () => {
        const result = await setResourceSharing(stranger.id, "budget", ownerBudgetId, groupId);
        expect(result).toEqual({ ok: false, error: "resource_not_found" });
      });

      it("resource_not_found takes priority over not_group_member even for an actual member who just doesn't own the resource", async () => {
        // memberWrite IS a member of `groupId` at this point (joined
        // earlier), so if ownership weren't checked first this would
        // wrongly report `not_group_member` instead of the correct
        // `resource_not_found` — the exact ordering bug this test guards.
        const result = await setResourceSharing(memberWrite.id, "budget", ownerBudgetId, groupId);
        expect(result).toEqual({ ok: false, error: "resource_not_found" });
      });

      it("a member (any permission level) can see the shared budget via getSharedGroupData", async () => {
        const data = await getSharedGroupData(memberRead.id, groupId);
        expect(data.budgets.some((b) => b.id === ownerBudgetId)).toBe(true);
      });

      it("CROSS-GROUP LEAKAGE CHECK: a stranger querying the same real groupId gets nothing back, not an error", async () => {
        const data = await getSharedGroupData(stranger.id, groupId);
        expect(data.budgets).toEqual([]);
        expect(data.bankAccounts).toEqual([]);
        expect(data.categories).toEqual([]);
      });

      it("a READ-only member cannot edit a budget they don't own, even via a raw update (RLS proof)", async () => {
        const result = await withUserScope(memberRead.id, (tx) =>
          tx.budget.updateMany({ where: { id: ownerBudgetId }, data: { monthlyLimit: 999_999n } }),
        );
        expect(result.count).toBe(0);

        const unchanged = await admin.budget.findUniqueOrThrow({ where: { id: ownerBudgetId } });
        expect(unchanged.monthlyLimit).toBe(100_000n);
      });

      it("a WRITE member CAN edit a budget shared into the group, even though they don't own it (positive control)", async () => {
        const result = await withUserScope(memberWrite.id, (tx) =>
          tx.budget.updateMany({ where: { id: ownerBudgetId }, data: { monthlyLimit: 150_000n } }),
        );
        expect(result.count).toBe(1);

        const updated = await admin.budget.findUniqueOrThrow({ where: { id: ownerBudgetId } });
        expect(updated.monthlyLimit).toBe(150_000n);
      });

      it("un-sharing removes it from every non-owner's view", async () => {
        const unshareResult = await setResourceSharing(owner.id, "budget", ownerBudgetId, null);
        expect(unshareResult).toEqual({ ok: true });

        const dataForMember = await getSharedGroupData(memberWrite.id, groupId);
        expect(dataForMember.budgets.some((b) => b.id === ownerBudgetId)).toBe(false);

        // The true owner can always still see their own (now personal-again) budget.
        const ownersOwnView = await getBudgetById(owner.id, ownerBudgetId);
        expect(ownersOwnView?.sharedGroupId).toBeNull();
      });

      it("personal asset vaults stay strictly isolated: sharing the BANK ACCOUNT never exposes its TRANSACTIONS", async () => {
        const shareResult = await setResourceSharing(owner.id, "bankAccount", ownerBankAccountId, groupId);
        expect(shareResult).toEqual({ ok: true });

        // The shared account itself becomes visible to a fellow member...
        const sharedData = await getSharedGroupData(memberWrite.id, groupId);
        expect(sharedData.bankAccounts.some((a) => a.id === ownerBankAccountId)).toBe(true);

        // ...but a transaction posted to that account is never visible to
        // anyone but its owner, regardless of the account's own sharing
        // state or the requester's WRITE standing in the group.
        await expect(getTransactionById(memberWrite.id, ownerTransactionId)).resolves.toBeNull();
        await expect(getTransactionById(memberRead.id, ownerTransactionId)).resolves.toBeNull();
        await expect(getTransactionById(stranger.id, ownerTransactionId)).resolves.toBeNull();
        await expect(getTransactionById(owner.id, ownerTransactionId)).resolves.toMatchObject({ id: ownerTransactionId });
      });
    });

    describe("leaving / removing members", () => {
      it("a member can leave the group themselves", async () => {
        const result = await removeMember(memberRead.id, groupId, memberRead.id);
        expect(result).toEqual({ ok: true });
        expect(await getMyMembership(memberRead.id, groupId)).toBeNull();
      });

      it("the owner cannot be removed", async () => {
        const result = await removeMember(owner.id, groupId, owner.id);
        expect(result).toEqual({ ok: false, error: "cannot_remove_owner" });
      });

      it("a non-owner cannot remove someone else", async () => {
        // memberWrite attempting to remove... there's no one left but the
        // owner (protected above) — assert against a nonexistent target
        // instead, which must still fail closed rather than throw.
        const result = await removeMember(memberWrite.id, groupId, stranger.id);
        expect(result).toEqual({ ok: false, error: "not_found" });
      });
    });

    // At this point: owner = OWNER/WRITE, memberWrite = MEMBER/WRITE,
    // memberRead already left. `ownerBankAccountId.sharedGroupId === groupId`
    // (shared earlier, above) — used below to prove DELETE un-shares it.
    describe("household lifecycle: rename / transfer ownership / delete (AGENTS.md §3s amendment)", () => {
      it("a non-owner cannot rename the group", async () => {
        const result = await renameSharedGroup(memberWrite.id, groupId, "Hijacked Name");
        expect(result).toEqual({ ok: false, error: "not_owner" });
      });

      it("the owner can rename the group", async () => {
        const result = await renameSharedGroup(owner.id, groupId, "The Renamed Household");
        expect(result).toEqual({ ok: true });

        const stored = await admin.sharedGroup.findUniqueOrThrow({ where: { id: groupId } });
        expect(stored.name).toBe("The Renamed Household");
      });

      it("transferring ownership to someone who isn't a member fails as target_not_found", async () => {
        const result = await transferGroupOwnership(owner.id, groupId, stranger.id);
        expect(result).toEqual({ ok: false, error: "target_not_found" });
      });

      it("transferring ownership to the current owner fails as target_already_owner", async () => {
        const result = await transferGroupOwnership(owner.id, groupId, owner.id);
        expect(result).toEqual({ ok: false, error: "target_already_owner" });
      });

      it("a non-owner cannot transfer ownership at all", async () => {
        const result = await transferGroupOwnership(memberWrite.id, groupId, memberWrite.id);
        expect(result).toEqual({ ok: false, error: "not_owner" });
      });

      it("the owner can transfer ownership to an existing non-owner member", async () => {
        const result = await transferGroupOwnership(owner.id, groupId, memberWrite.id);
        expect(result).toEqual({ ok: true });

        const stored = await admin.sharedGroup.findUniqueOrThrow({ where: { id: groupId } });
        expect(stored.createdById).toBe(memberWrite.id);

        const newOwnerMembership = await getMyMembership(memberWrite.id, groupId);
        expect(newOwnerMembership).toMatchObject({ role: "OWNER", permission: "WRITE" });

        const formerOwnerMembership = await getMyMembership(owner.id, groupId);
        expect(formerOwnerMembership).toMatchObject({ role: "MEMBER" });
      });

      it("the former owner can no longer rename the group after transfer", async () => {
        const result = await renameSharedGroup(owner.id, groupId, "Should Not Apply");
        expect(result).toEqual({ ok: false, error: "not_owner" });
      });

      it("the new owner can rename the group after transfer", async () => {
        const result = await renameSharedGroup(memberWrite.id, groupId, "Owned By New Owner");
        expect(result).toEqual({ ok: true });
      });

      it("the former owner (now a plain member) cannot delete the group", async () => {
        const result = await deleteSharedGroup(owner.id, groupId);
        expect(result).toEqual({ ok: false, error: "not_owner" });
      });

      it("the new owner can delete the group — members cascade, shared resources un-share, nothing else is touched", async () => {
        const result = await deleteSharedGroup(memberWrite.id, groupId);
        expect(result).toEqual({ ok: true });

        expect(await admin.sharedGroup.findUnique({ where: { id: groupId } })).toBeNull();
        expect(await admin.groupMember.findMany({ where: { sharedGroupId: groupId } })).toHaveLength(0);

        // Budget/BankAccount/Category revert to purely personal
        // (onDelete: SetNull) — never deleted, per the DAL doc comment.
        const bankAccount = await admin.bankAccount.findUniqueOrThrow({ where: { id: ownerBankAccountId } });
        expect(bankAccount.sharedGroupId).toBeNull();

        // The underlying transaction and its owner's account are
        // completely untouched by a household-group deletion.
        await expect(getTransactionById(owner.id, ownerTransactionId)).resolves.toMatchObject({ id: ownerTransactionId });
      });
    });
  },
);
