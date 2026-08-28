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
// already knowing the id (see that file's doc comment). Every other file
// under src/ — the DAL, routes, Server Components — must always go
// through src/server/db/client.ts instead.
const ADMIN_CLIENT_IMPORT = /from\s+["'].*\/admin-client["']/;

describe("guard: nothing under src/ imports the admin DB client, except the auth bootstrap", () => {
  it("only admin-client.ts itself and current-user.ts reference admin-client", () => {
    const allowedImporters = [
      path.resolve(SRC_ROOT, "server", "db", "admin-client.ts"),
      path.resolve(SRC_ROOT, "server", "auth", "current-user.ts"),
    ];

    const files = walkSourceFiles(SRC_ROOT, [".ts", ".tsx"]).filter((file) => !allowedImporters.includes(file));

    const violations = files
      .map((file) => ({ file, content: readFileSync(file, "utf8") }))
      .filter(({ content }) => ADMIN_CLIENT_IMPORT.test(content))
      .map(({ file }) => path.relative(process.cwd(), file));

    expect(violations).toEqual([]);
  });
});
