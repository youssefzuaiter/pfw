-- Household Lifecycle Management: ownership transfer (AGENTS.md §3s
-- amendment). No Prisma-model changes — this is a pure RLS-policy
-- widening on "SharedGroup", the same "hand-write the SQL, no
-- `prisma migrate dev` shadow-db replay" pattern every RLS-touching
-- migration in this history uses (§3p/§3s/§3t's migration-checksum
-- incident notes) — applied directly since a prior migration was
-- already hand-edited post-apply.
--
-- SharedGroup's original `update_scope` policy (20260829120000) required
-- BOTH the OLD and the NEW row's "createdById" to equal the acting
-- session, which makes "transfer ownership" — an UPDATE that changes
-- "createdById" to someone ELSE's id — structurally impossible, not just
-- unbuilt: no value of "createdById" the current owner could write would
-- ever satisfy `WITH CHECK ("createdById" = current_setting(...))` once
-- it's someone else's id.
--
-- Fix: keep `USING` exactly as strict as before (only the CURRENT owner
-- may initiate this update at all — unchanged, and still the primary
-- gate), and widen `WITH CHECK` to also accept a NEW "createdById" that
-- already has a "GroupMember" row for this exact group — i.e. ownership
-- can only ever transfer to somebody already IN the household, never to
-- an arbitrary/unrelated user id. This deliberately does not need a new
-- parameterized SECURITY DEFINER function (the original migration's own
-- comment on `pfw_my_shared_group_ids` explains why a *parameterized*
-- SECURITY DEFINER helper taking an arbitrary target-user argument would
-- be a privilege-escalation footgun) — this EXISTS subquery reads
-- "GroupMember" directly, under the invoking role's own normal RLS: the
-- acting session is the group's current owner, who can already see every
-- member's row via GroupMember's own `select_scope` policy, so the
-- subquery is never wrongly denied visibility into the very group it's
-- checking.
--
-- src/server/dal/shared-groups.ts's `transferGroupOwnership` adds its
-- own DAL-level pre-check (target must be an existing, non-owner member)
-- before ever attempting this UPDATE — same "DAL is the primary control,
-- RLS is defense-in-depth on top of it" split as everywhere else (§3a) —
-- so this policy only ever needs to be the BACKSTOP against a bypassed
-- DAL, not the sole gate.
DROP POLICY update_scope ON "SharedGroup";

CREATE POLICY update_scope ON "SharedGroup" FOR UPDATE
  USING ("createdById" = current_setting('app.current_user_id', true))
  WITH CHECK (
    "createdById" = current_setting('app.current_user_id', true)
    OR EXISTS (
      SELECT 1 FROM "GroupMember" gm
      WHERE gm."sharedGroupId" = "SharedGroup"."id"
        AND gm."userId" = "SharedGroup"."createdById"
    )
  );
