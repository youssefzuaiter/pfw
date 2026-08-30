-- Granular Household & Shared Budget Spaces (AGENTS.md §3s).
--
-- Schema DDL below is Prisma-generated (via `prisma migrate diff` against
-- the live dev database, since a prior migration in this history had
-- already been hand-edited after being applied — see AGENTS.md §3p's
-- "migration-checksum incident" note — which makes `prisma migrate dev`'s
-- shadow-database replay refuse to run without a full reset; diffing the
-- live database directly sidesteps that shadow-db replay entirely and
-- required no destructive reset of real (seeded) local data). Everything
-- from the "Row-Level Security" comment onward is hand-written, same
-- established pattern as every other migration in this history that
-- touches RLS (`prisma migrate dev` does not manage RLS declaratively at
-- all).

-- CreateEnum
CREATE TYPE "GroupRole" AS ENUM ('OWNER', 'MEMBER');

-- CreateEnum
CREATE TYPE "SharePermission" AS ENUM ('READ', 'WRITE');

-- CreateEnum
CREATE TYPE "InviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

-- AlterTable
ALTER TABLE "BankAccount" ADD COLUMN     "sharedGroupId" TEXT;

-- AlterTable
ALTER TABLE "Budget" ADD COLUMN     "sharedGroupId" TEXT;

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "sharedGroupId" TEXT;

-- CreateTable
CREATE TABLE "SharedGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SharedGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupMember" (
    "id" TEXT NOT NULL,
    "sharedGroupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "GroupRole" NOT NULL DEFAULT 'MEMBER',
    "permission" "SharePermission" NOT NULL DEFAULT 'READ',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupInvite" (
    "id" TEXT NOT NULL,
    "sharedGroupId" TEXT NOT NULL,
    "invitedEmail" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "permission" "SharePermission" NOT NULL DEFAULT 'READ',
    "status" "InviteStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,
    "acceptedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SharedGroup_createdById_idx" ON "SharedGroup"("createdById");

-- CreateIndex
CREATE INDEX "GroupMember_userId_idx" ON "GroupMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupMember_sharedGroupId_userId_key" ON "GroupMember"("sharedGroupId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupInvite_tokenHash_key" ON "GroupInvite"("tokenHash");

-- CreateIndex
CREATE INDEX "GroupInvite_sharedGroupId_idx" ON "GroupInvite"("sharedGroupId");

-- CreateIndex
CREATE INDEX "GroupInvite_invitedEmail_idx" ON "GroupInvite"("invitedEmail");

-- CreateIndex
CREATE INDEX "BankAccount_sharedGroupId_idx" ON "BankAccount"("sharedGroupId");

-- CreateIndex
CREATE INDEX "Budget_sharedGroupId_idx" ON "Budget"("sharedGroupId");

-- CreateIndex
CREATE INDEX "Category_sharedGroupId_idx" ON "Category"("sharedGroupId");

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_sharedGroupId_fkey" FOREIGN KEY ("sharedGroupId") REFERENCES "SharedGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_sharedGroupId_fkey" FOREIGN KEY ("sharedGroupId") REFERENCES "SharedGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_sharedGroupId_fkey" FOREIGN KEY ("sharedGroupId") REFERENCES "SharedGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SharedGroup" ADD CONSTRAINT "SharedGroup_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_sharedGroupId_fkey" FOREIGN KEY ("sharedGroupId") REFERENCES "SharedGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupInvite" ADD CONSTRAINT "GroupInvite_sharedGroupId_fkey" FOREIGN KEY ("sharedGroupId") REFERENCES "SharedGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupInvite" ADD CONSTRAINT "GroupInvite_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupInvite" ADD CONSTRAINT "GroupInvite_acceptedById_fkey" FOREIGN KEY ("acceptedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- =====================================================================
-- Row-Level Security
-- =====================================================================
--
-- Two helper functions used by Budget/BankAccount/Category's policies
-- below, so the same "am I a member / can I write" subquery isn't
-- repeated 4 times per table x 3 tables. Both are STABLE (no writes,
-- safe to call multiple times per statement) and run as the invoking
-- role (pfw_runtime) — the GroupMember query inside each one is itself
-- subject to GroupMember's own RLS policy (below), but that's harmless
-- here: every call site only ever asks "does a GroupMember row exist for
-- (this group, ME)", and GroupMember's policy always allows a user to
-- see their OWN membership row, so the answer is never wrongly withheld.
--
-- IMPORTANT — what these functions do and do NOT close: they answer "is
-- the CURRENT SESSION a member/writer of this group", not "is the ROW'S
-- OWNER a legitimate member of the group it claims to be shared into".
-- The latter (preventing a user from mis-sharing their own resource into
-- an arbitrary groupId they have no standing in) is enforced at the DAL
-- layer (`src/server/dal/shared-groups.ts`'s `setResourceSharing`, which
-- verifies write-standing on the target group before ever setting
-- `sharedGroupId`) — this app's established "DAL is the primary control,
-- RLS is defense-in-depth on top of it" split (AGENTS.md §3a). RLS here
-- still fully closes the actual IDOR/cross-tenant concern: a user with
-- no membership row at all can never SELECT/UPDATE/DELETE another user's
-- shared row, and a READ-only member can never mutate one, regardless of
-- what the DAL does or doesn't check.
CREATE OR REPLACE FUNCTION pfw_is_group_member(target_group_id TEXT) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "GroupMember"
    WHERE "sharedGroupId" = target_group_id
      AND "userId" = current_setting('app.current_user_id', true)
  );
$$;

CREATE OR REPLACE FUNCTION pfw_can_write_group(target_group_id TEXT) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "GroupMember"
    WHERE "sharedGroupId" = target_group_id
      AND "userId" = current_setting('app.current_user_id', true)
      AND ("role" = 'OWNER' OR "permission" = 'WRITE')
  );
$$;

-- --- SharedGroup ------------------------------------------------------
-- Visible to its creator and to every member. Only the creator may
-- rename/delete it or otherwise change it — there is no "transfer
-- ownership" flow in this pass (SharedGroup's own model comment).
ALTER TABLE "SharedGroup" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SharedGroup" FORCE ROW LEVEL SECURITY;

CREATE POLICY select_scope ON "SharedGroup" FOR SELECT
  USING (
    "createdById" = current_setting('app.current_user_id', true)
    OR pfw_is_group_member("id")
  );

CREATE POLICY insert_scope ON "SharedGroup" FOR INSERT
  WITH CHECK ("createdById" = current_setting('app.current_user_id', true));

CREATE POLICY update_scope ON "SharedGroup" FOR UPDATE
  USING ("createdById" = current_setting('app.current_user_id', true))
  WITH CHECK ("createdById" = current_setting('app.current_user_id', true));

CREATE POLICY delete_scope ON "SharedGroup" FOR DELETE
  USING ("createdById" = current_setting('app.current_user_id', true));

-- A genuinely self-referential policy on GroupMember (its own SELECT
-- policy querying GroupMember again inside a subquery) hits Postgres's
-- static recursion guard ("infinite recursion detected in policy for
-- relation") at query-plan time — this is a real, verified error, not a
-- data-dependent runtime concern that "always terminates via the direct
-- disjunct" the way a first draft of this migration assumed. The
-- standard, correct fix for "a table's policy needs to query that same
-- table" is a `SECURITY DEFINER` helper function owned by a role that
-- bypasses RLS (here, `pfw_app`, the superuser this migration runs as) —
-- its body executes with the OWNER's privileges, so its internal SELECT
-- against GroupMember never re-triggers GroupMember's own policy at all,
-- breaking the cycle. Deliberately takes NO parameter and reads
-- `app.current_user_id` internally instead: a SECURITY DEFINER function
-- is callable directly by anyone with EXECUTE (the default grant), so if
-- it took a target-user-id argument, `pfw_runtime` could call it ad hoc
-- with an arbitrary other user's id and bypass RLS to enumerate THEIR
-- groups — reading the session variable internally instead means it can
-- only ever reveal the CALLING SESSION's own memberships, exactly the
-- same fact `pfw_is_group_member`/`pfw_can_write_group` below already
-- expose no differently, just via a path that doesn't recurse.
CREATE OR REPLACE FUNCTION pfw_my_shared_group_ids() RETURNS SETOF TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT "sharedGroupId" FROM "GroupMember" WHERE "userId" = current_setting('app.current_user_id', true);
$$;

-- --- GroupMember --------------------------------------------------------
-- SELECT: your own membership row, or every row in ANY group you also
-- belong to — the standard "team roster visible to every teammate" rule,
-- made non-recursive via `pfw_my_shared_group_ids()` above. Every member
-- needs to see the full roster, not just the owner — this is also what
-- makes User's own extended SELECT policy below actually resolve a
-- fellow member's `displayName` on a shared resource ("shared by
-- Dana"), which needs this same fellow-member-visibility fact to
-- already hold for GroupMember before it can be layered on top for User.
--
-- INSERT: self only (`userId` must equal the acting session) — this is
-- what makes "accepting your own invite" the *only* way a membership row
-- can ever be created; there is no "owner directly adds someone" path.
--
-- UPDATE: owner-only, deliberately with NO self-service path at all —
-- if a member could update their own row, `WITH CHECK ("userId" =
-- current_user)` would let them set their own `permission`/`role` to
-- WRITE/OWNER, a privilege-escalation bug. Only the group's creator may
-- change anyone's role or permission.
--
-- DELETE: self (leave the group) or the group's owner (remove a member).
ALTER TABLE "GroupMember" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GroupMember" FORCE ROW LEVEL SECURITY;

CREATE POLICY select_scope ON "GroupMember" FOR SELECT
  USING (
    "userId" = current_setting('app.current_user_id', true)
    OR "sharedGroupId" IN (SELECT pfw_my_shared_group_ids())
  );

CREATE POLICY insert_scope ON "GroupMember" FOR INSERT
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

CREATE POLICY update_scope ON "GroupMember" FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "SharedGroup" sg
      WHERE sg."id" = "GroupMember"."sharedGroupId"
        AND sg."createdById" = current_setting('app.current_user_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "SharedGroup" sg
      WHERE sg."id" = "GroupMember"."sharedGroupId"
        AND sg."createdById" = current_setting('app.current_user_id', true)
    )
  );

CREATE POLICY delete_scope ON "GroupMember" FOR DELETE
  USING (
    "userId" = current_setting('app.current_user_id', true)
    OR EXISTS (
      SELECT 1 FROM "SharedGroup" sg
      WHERE sg."id" = "GroupMember"."sharedGroupId"
        AND sg."createdById" = current_setting('app.current_user_id', true)
    )
  );

-- --- GroupInvite --------------------------------------------------------
-- Creator-only for every command. The one deliberate exception is the
-- accept-invite flow itself: the accepting user is (by definition) not
-- yet a member and not the invite's creator, so they have no row-level
-- standing to SELECT the invite by token or mark it ACCEPTED under this
-- policy. That flow uses the admin (RLS-bypassing) client for exactly
-- those two narrow operations — `src/server/groups/invite-admin-ops.ts`,
-- allowlisted in `tests/guards/admin-client-boundary.test.ts` — the same
-- "one deliberate, documented, narrowly-scoped bypass" pattern already
-- established for `getCurrentUser()` and the zero-knowledge vault's
-- legacy-note migration (AGENTS.md §3m).
ALTER TABLE "GroupInvite" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GroupInvite" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "GroupInvite"
  USING ("createdById" = current_setting('app.current_user_id', true))
  WITH CHECK ("createdById" = current_setting('app.current_user_id', true));

-- --- User: extend SELECT to fellow household members -------------------
-- The original RLS migration (prisma/migrations/*_rls_and_runtime_role)
-- gave `User` one blanket ALL-commands `tenant_isolation` policy: strictly
-- self only, no exceptions. That's too strict for this feature: showing
-- "shared by Dana" on a household resource, or a member roster at all,
-- requires reading another real user's `displayName` — which a Prisma
-- relational `include`/`select` on `user` cannot do at all under a
-- self-only policy (it silently resolves to `null` for anyone who isn't
-- the querying session, a real bug caught by hand-testing the actual
-- rendered `/budgets?view=household` page, not just by a DAL-level test).
--
-- Fix: split `User` into 4 per-command policies (mirroring the
-- Budget/BankAccount/Category split above) — SELECT is widened to
-- "yourself, or anyone who shares a household with you" (leaning on
-- GroupMember's own now-broadened "any fellow member sees the roster"
-- policy above); INSERT/UPDATE/DELETE stay exactly as strict as before,
-- self only. A fellow member seeing your `displayName`/`email` this way
-- is the intended, minimal disclosure this feature needs — every other
-- field on every other personal table remains exactly as isolated as it
-- was before this migration.
DROP POLICY tenant_isolation ON "User";

CREATE POLICY select_scope ON "User" FOR SELECT
  USING (
    "id" = current_setting('app.current_user_id', true)
    OR EXISTS (
      SELECT 1 FROM "GroupMember" gm
      WHERE gm."userId" = "User"."id"
        AND gm."sharedGroupId" IN (SELECT pfw_my_shared_group_ids())
    )
  );

CREATE POLICY insert_scope ON "User" FOR INSERT
  WITH CHECK ("id" = current_setting('app.current_user_id', true));

CREATE POLICY update_scope ON "User" FOR UPDATE
  USING ("id" = current_setting('app.current_user_id', true))
  WITH CHECK ("id" = current_setting('app.current_user_id', true));

CREATE POLICY delete_scope ON "User" FOR DELETE
  USING ("id" = current_setting('app.current_user_id', true));

-- --- Budget / BankAccount / Category: shared-resource policies ---------
-- These three tables move from a single blanket `tenant_isolation`
-- policy to 4 per-command policies each, because (unlike every other
-- table) they now need to distinguish "can see" from "can write" for a
-- non-owner group member — a single ALL-commands policy can't express
-- that distinction for DELETE (which has no WITH CHECK clause at all;
-- see the file's other migration for how every other table's simpler
-- policy works). The shape is identical across all three tables, only
-- the table name changes.
--
-- Two distinct write capabilities, deliberately NOT collapsed into one:
--  1. Sharing (or re-sharing) YOUR OWN resource into a group you belong
--     to — this only requires being a member at all (`pfw_is_group_member`),
--     any permission level. Contributing your own budget/account/category
--     for the household to see isn't "editing someone else's data", so
--     gating it behind WRITE would be a stricter rule than the feature
--     actually needs.
--  2. Editing or deleting a resource *someone else* shared into the
--     group — this requires `pfw_can_write_group` (OWNER role, or
--     MEMBER with `permission = WRITE`). A plain READ member can see
--     every shared row in the group but can never mutate one they don't
--     own.
-- The true owner (`"userId" = current_user`) can always see, edit, and
-- delete their own row regardless of their current standing in whatever
-- group it's shared into — losing WRITE (or being removed from the
-- group entirely, since `sharedGroup` uses `onDelete: SetNull`) never
-- locks the actual owner out of their own data, only affects whether
-- *others* can act on it.

DROP POLICY tenant_isolation ON "Budget";

CREATE POLICY select_scope ON "Budget" FOR SELECT
  USING (
    "userId" = current_setting('app.current_user_id', true)
    OR ("sharedGroupId" IS NOT NULL AND pfw_is_group_member("sharedGroupId"))
  );

CREATE POLICY insert_scope ON "Budget" FOR INSERT
  WITH CHECK (
    "userId" = current_setting('app.current_user_id', true)
    AND ("sharedGroupId" IS NULL OR pfw_is_group_member("sharedGroupId"))
  );

CREATE POLICY update_scope ON "Budget" FOR UPDATE
  USING (
    ("userId" = current_setting('app.current_user_id', true) AND ("sharedGroupId" IS NULL OR pfw_is_group_member("sharedGroupId")))
    OR ("userId" != current_setting('app.current_user_id', true) AND "sharedGroupId" IS NOT NULL AND pfw_can_write_group("sharedGroupId"))
  )
  WITH CHECK (
    ("userId" = current_setting('app.current_user_id', true) AND ("sharedGroupId" IS NULL OR pfw_is_group_member("sharedGroupId")))
    OR ("userId" != current_setting('app.current_user_id', true) AND "sharedGroupId" IS NOT NULL AND pfw_can_write_group("sharedGroupId"))
  );

CREATE POLICY delete_scope ON "Budget" FOR DELETE
  USING (
    "userId" = current_setting('app.current_user_id', true)
    OR ("sharedGroupId" IS NOT NULL AND pfw_can_write_group("sharedGroupId"))
  );

DROP POLICY tenant_isolation ON "BankAccount";

CREATE POLICY select_scope ON "BankAccount" FOR SELECT
  USING (
    "userId" = current_setting('app.current_user_id', true)
    OR ("sharedGroupId" IS NOT NULL AND pfw_is_group_member("sharedGroupId"))
  );

CREATE POLICY insert_scope ON "BankAccount" FOR INSERT
  WITH CHECK (
    "userId" = current_setting('app.current_user_id', true)
    AND ("sharedGroupId" IS NULL OR pfw_is_group_member("sharedGroupId"))
  );

CREATE POLICY update_scope ON "BankAccount" FOR UPDATE
  USING (
    ("userId" = current_setting('app.current_user_id', true) AND ("sharedGroupId" IS NULL OR pfw_is_group_member("sharedGroupId")))
    OR ("userId" != current_setting('app.current_user_id', true) AND "sharedGroupId" IS NOT NULL AND pfw_can_write_group("sharedGroupId"))
  )
  WITH CHECK (
    ("userId" = current_setting('app.current_user_id', true) AND ("sharedGroupId" IS NULL OR pfw_is_group_member("sharedGroupId")))
    OR ("userId" != current_setting('app.current_user_id', true) AND "sharedGroupId" IS NOT NULL AND pfw_can_write_group("sharedGroupId"))
  );

CREATE POLICY delete_scope ON "BankAccount" FOR DELETE
  USING (
    "userId" = current_setting('app.current_user_id', true)
    OR ("sharedGroupId" IS NOT NULL AND pfw_can_write_group("sharedGroupId"))
  );

DROP POLICY tenant_isolation ON "Category";

CREATE POLICY select_scope ON "Category" FOR SELECT
  USING (
    "userId" = current_setting('app.current_user_id', true)
    OR ("sharedGroupId" IS NOT NULL AND pfw_is_group_member("sharedGroupId"))
  );

CREATE POLICY insert_scope ON "Category" FOR INSERT
  WITH CHECK (
    "userId" = current_setting('app.current_user_id', true)
    AND ("sharedGroupId" IS NULL OR pfw_is_group_member("sharedGroupId"))
  );

CREATE POLICY update_scope ON "Category" FOR UPDATE
  USING (
    ("userId" = current_setting('app.current_user_id', true) AND ("sharedGroupId" IS NULL OR pfw_is_group_member("sharedGroupId")))
    OR ("userId" != current_setting('app.current_user_id', true) AND "sharedGroupId" IS NOT NULL AND pfw_can_write_group("sharedGroupId"))
  )
  WITH CHECK (
    ("userId" = current_setting('app.current_user_id', true) AND ("sharedGroupId" IS NULL OR pfw_is_group_member("sharedGroupId")))
    OR ("userId" != current_setting('app.current_user_id', true) AND "sharedGroupId" IS NOT NULL AND pfw_can_write_group("sharedGroupId"))
  );

CREATE POLICY delete_scope ON "Category" FOR DELETE
  USING (
    "userId" = current_setting('app.current_user_id', true)
    OR ("sharedGroupId" IS NOT NULL AND pfw_can_write_group("sharedGroupId"))
  );
