import "server-only";
import { cache } from "react";
import { createAdminClient } from "../db/admin-client";

/**
 * Resolves the authenticated user's identity. There's no real login flow
 * yet (see AGENTS.md decision #1) — this always resolves to the single
 * seeded demo user, by a fixed known email.
 *
 * This is the one place outside prisma/seed/ and tests/ that's allowed to
 * use the admin (RLS-bypassing) client — see
 * tests/guards/admin-client-boundary.test.ts. Resolving "who is this" is
 * inherently a bootstrap operation that has to run before any userId
 * exists to scope by (the User table's own RLS policy is keyed on
 * already knowing the id) — the same reason a real login endpoint
 * typically runs with different privileges than authenticated per-request
 * access. Every function downstream of this one receives the resolved
 * userId as a plain argument and goes through the normal RLS-scoped path.
 *
 * Swapping in real session-based auth later only changes this function's
 * internals — every call site already treats the return value as an
 * opaque, already-authenticated user id.
 *
 * Wrapped in React's `cache()` so multiple components in the same render
 * tree share one lookup instead of hitting the database repeatedly for
 * the same request.
 */
const SEED_USER_EMAIL = "demo@pfw.local";

/**
 * The Activity Monitor's real-time half (AGENTS.md §3t) — every resolved
 * request is "proof of life" for the Dead Man's Switch. Debounced
 * in-memory (same `Map`-based, single-process pattern as
 * src/server/api/rate-limit.ts — a multi-instance Tier 3 deployment
 * would swap this for a shared store behind the same function shape) so
 * a page that renders three components sharing this cached lookup, or a
 * user browsing normally, doesn't write to `DeadMansSwitch` on every
 * single request — only once per `ACTIVITY_TOUCH_DEBOUNCE_MS`.
 *
 * Deliberately only reverts GRACE_PERIOD -> ACTIVE, never touches a
 * TRIGGERED switch — see DeadMansSwitch's model comment for why an
 * already-triggered recovery requires the owner's explicit
 * `cancelRecovery()` action instead of a passive page load silently
 * undoing beneficiaries' already-submitted shares.
 */
const ACTIVITY_TOUCH_DEBOUNCE_MS = 5 * 60 * 1000;
const lastActivityTouchAt = new Map<string, number>();

async function touchDeadMansSwitchActivity(admin: ReturnType<typeof createAdminClient>, userId: string): Promise<void> {
  const now = Date.now();
  const lastTouch = lastActivityTouchAt.get(userId);
  if (lastTouch !== undefined && now - lastTouch < ACTIVITY_TOUCH_DEBOUNCE_MS) return;
  lastActivityTouchAt.set(userId, now);

  await admin.deadMansSwitch.updateMany({
    where: { userId, status: { in: ["ACTIVE", "GRACE_PERIOD"] } },
    data: { status: "ACTIVE", lastActivityAt: new Date(now), graceStartedAt: null },
  });
}

export const getCurrentUser = cache(async () => {
  const admin = createAdminClient();
  const user = await admin.user.findUnique({ where: { email: SEED_USER_EMAIL } });
  if (!user) {
    throw new Error(`Seed user not found (${SEED_USER_EMAIL}). Run \`npm run db:seed\` first.`);
  }

  await touchDeadMansSwitchActivity(admin, user.id);

  return user;
});
