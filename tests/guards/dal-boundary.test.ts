import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { walkSourceFiles } from "./walk-source-files";

const APP_ROOT = path.resolve(__dirname, "../../src/app");
const ALLOWED_PRISMA_IMPORTER = path.resolve(__dirname, "../../src/server/dal");

const PRISMA_IMPORT =
  /from\s+["']@prisma\/client["']|from\s+["'].*\/generated\/prisma[^"']*["']|from\s+["'].*\/server\/db\/(client|admin-client)["']/;

/**
 * Route handlers and Server Components must never import Prisma (or the
 * DB client modules) directly — all data access goes through the Data
 * Access Layer (`src/server/dal`), which is the only place that is
 * allowed to enforce `where: { userId }` and RLS scoping.
 *
 * No route handlers exist yet (they land in Phase 4), so this test is
 * currently vacuous by construction — it starts enforcing the boundary the
 * moment the first route handler is added.
 */
describe("guard: route handlers never import Prisma directly", () => {
  it("no file under src/app imports Prisma outside the DAL", () => {
    const files = walkSourceFiles(APP_ROOT, ["route.ts", "page.tsx", "layout.tsx"]).filter(
      (file) => !file.startsWith(ALLOWED_PRISMA_IMPORTER),
    );

    const violations = files
      .map((file) => ({ file, content: readFileSync(file, "utf8") }))
      .filter(({ content }) => PRISMA_IMPORT.test(content))
      .map(({ file }) => path.relative(process.cwd(), file));

    expect(violations).toEqual([]);
  });
});
