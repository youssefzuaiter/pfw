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

export const getCurrentUser = cache(async () => {
  const admin = createAdminClient();
  const user = await admin.user.findUnique({ where: { email: SEED_USER_EMAIL } });
  if (!user) {
    throw new Error(`Seed user not found (${SEED_USER_EMAIL}). Run \`npm run db:seed\` first.`);
  }
  return user;
});
