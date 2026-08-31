import "server-only";
import { cache } from "react";
import { auth } from "./auth";
import { createAdminClient } from "../db/admin-client";

/**
 * Resolves the authenticated user's identity (AGENTS.md §3ff — real
 * Auth.js session-based auth, replacing the old hardcoded single-seeded-
 * demo-user resolution this comment used to describe).
 *
 * This is the one place outside prisma/seed/, the household/vault invite
 * flows, and tests/ that's allowed to use the admin (RLS-bypassing)
 * client — see tests/guards/admin-client-boundary.test.ts. Still a
 * bootstrap operation in the same sense it always was: even with a
 * trusted, cryptographically-verified user id already in hand (from
 * Auth.js's signed session JWT), looking up that id's OWN `User` row is
 * what the RLS session variable itself depends on already being set to
 * — the exact chicken-and-egg §5 decision #1 originally described.
 * Deliberately NOT changed to route through the normal `withUserScope`
 * RLS path now that a trusted id exists — keeping this one call site as
 * the sole admin-client exception it already was, tested and
 * allowlisted, is a smaller, more conservative change than adding a new
 * RLS-scoped code path here too.
 *
 * The external contract is UNCHANGED from before this pass: always
 * resolves to a real `User` row, or throws — never returns null, never
 * redirects. That's what lets every one of this app's dozens of
 * existing call sites (every page, every route) need zero changes for
 * real auth to land — exactly what §5 decision #1 always promised.
 * `src/proxy.ts` is the actual, reliable authentication GATE (redirects
 * an unauthenticated request before any Server Component or route
 * handler runs at all); this function's own "no session" branch below
 * is pure defense-in-depth, expected to be unreachable in normal
 * operation.
 *
 * Wrapped in React's `cache()` so multiple components in the same render
 * tree share one lookup instead of hitting the database repeatedly for
 * the same request.
 */

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
  const session = await auth();
  const sessionUserId = session?.user?.id;
  if (!sessionUserId) {
    // See this function's own doc comment above — src/proxy.ts is
    // supposed to gate every protected route before this branch can
    // ever be reached. Throwing loudly (not attempting a redirect this
    // deep) is the same "fail closed, not open" posture RLS already
    // takes when app.current_user_id is unset.
    throw new Error(
      "getCurrentUser() called with no authenticated session — this should be unreachable. " +
        "src/proxy.ts is supposed to redirect every protected route to /login before this ever runs.",
    );
  }

  const admin = createAdminClient();
  const user = await admin.user.findUnique({ where: { id: sessionUserId } });
  if (!user) {
    throw new Error(`Authenticated session references a user that no longer exists (id ${sessionUserId}).`);
  }

  await touchDeadMansSwitchActivity(admin, user.id);

  return user;
});
