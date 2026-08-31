import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { walkSourceFiles } from "./walk-source-files";

const SRC_ROOT = path.resolve(__dirname, "../../src");

// The admin client (pfw_app, superuser, bypasses RLS entirely) may only be
// used by: the seed script (prisma/seed/) and integration tests that need
// to set up fixtures without per-user scoping (neither lives under src/,
// so this guard only has to check src/ itself); and
// src/server/auth/current-user.ts, the one legitimate bootstrap exception
// — resolving "who is the current user" has to run before any userId
// exists to scope by, since the User table's own RLS policy is keyed on
// already knowing the id (see that file's doc comment); and
// src/server/groups/invite-admin-ops.ts, the Household Spaces invite/
// accept flow's own narrow bootstrap exception (AGENTS.md §3s) — the
// accepting user has no row-level standing on the creator-only
// `GroupInvite` table until their own `GroupMember` row exists, so
// looking the invite up by token and marking it accepted both have to
// happen before that row exists, the same shape as the identity-bootstrap
// problem `current-user.ts` solves; and
// src/server/dead-mans-switch/recovery-admin-ops.ts, the Dead Man's
// Switch's own narrow bootstrap exception (AGENTS.md §3t) — same shape
// as invite-admin-ops.ts, for a beneficiary holding an invite token
// rather than a household invite; and
// src/server/dead-mans-switch/inactivity-check.ts, a DIFFERENT kind of
// exception — a scheduled batch job (AGENTS.md §3t) with no
// authenticated request and therefore no single userId to scope a
// withUserScope transaction by at all, since it has to scan every user's
// DeadMansSwitch row in one pass; and
// src/server/auth/credentials.ts, real authentication's own bootstrap
// exception (AGENTS.md §3ff) — login and registration are the identity-
// bootstrap problem itself: verifying credentials or creating a brand
// new User row both have to happen before any userId exists to scope a
// withUserScope call by, the same shape current-user.ts already
// establishes. Every other file under src/ — the DAL, routes, Server
// Components — must always go through src/server/db/client.ts instead.
const ADMIN_CLIENT_IMPORT = /from\s+["'].*\/admin-client["']/;

describe("guard: nothing under src/ imports the admin DB client, except the auth bootstrap", () => {
  it("only the allowlisted bootstrap/batch files reference admin-client", () => {
    const allowedImporters = [
      path.resolve(SRC_ROOT, "server", "db", "admin-client.ts"),
      path.resolve(SRC_ROOT, "server", "auth", "current-user.ts"),
      path.resolve(SRC_ROOT, "server", "groups", "invite-admin-ops.ts"),
      path.resolve(SRC_ROOT, "server", "dead-mans-switch", "recovery-admin-ops.ts"),
      path.resolve(SRC_ROOT, "server", "dead-mans-switch", "inactivity-check.ts"),
      path.resolve(SRC_ROOT, "server", "auth", "credentials.ts"),
    ];

    const files = walkSourceFiles(SRC_ROOT, [".ts", ".tsx"]).filter((file) => !allowedImporters.includes(file));

    const violations = files
      .map((file) => ({ file, content: readFileSync(file, "utf8") }))
      .filter(({ content }) => ADMIN_CLIENT_IMPORT.test(content))
      .map(({ file }) => path.relative(process.cwd(), file));

    expect(violations).toEqual([]);
  });
});
