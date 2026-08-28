import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { walkSourceFiles } from "./walk-source-files";

const SRC_ROOT = path.resolve(__dirname, "../../src");
const SERVER_ONLY_ROOT = path.resolve(SRC_ROOT, "server");

const NEXT_PUBLIC_SECRET_LOOKING_NAME =
  /NEXT_PUBLIC_[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL)/;

const SECRET_ENV_VAR_REFERENCE =
  /process\.env\.(ANTHROPIC_API_KEY|DATABASE_URL|APP_DATABASE_URL|ENCRYPTION_KEY)\b/;

/**
 * Source-level half of Section 5's "grep client bundles in CI for stray
 * NEXT_PUBLIC_ secrets" control. The build-output half (grepping the
 * compiled .next/static bundle for a secret value) is a Phase 8 CI
 * pipeline concern; this guard runs on every test invocation instead of
 * only in CI, and catches the mistake before a secret is ever prefixed
 * with NEXT_PUBLIC_ or read outside the server-only boundary.
 */
describe("guard: no NEXT_PUBLIC_ secrets, no secret env reads outside src/server", () => {
  const files = walkSourceFiles(SRC_ROOT, [".ts", ".tsx"]).filter(
    (file) => !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"),
  );

  it("never defines a NEXT_PUBLIC_ variable that looks like a secret", () => {
    const violations = files
      .map((file) => ({ file, content: readFileSync(file, "utf8") }))
      .filter(({ content }) => NEXT_PUBLIC_SECRET_LOOKING_NAME.test(content))
      .map(({ file }) => path.relative(process.cwd(), file));

    expect(violations).toEqual([]);
  });

  it("reads secret env vars only from src/server", () => {
    const violations = files
      .filter((file) => !file.startsWith(SERVER_ONLY_ROOT))
      .map((file) => ({ file, content: readFileSync(file, "utf8") }))
      .filter(({ content }) => SECRET_ENV_VAR_REFERENCE.test(content))
      .map(({ file }) => path.relative(process.cwd(), file));

    expect(violations).toEqual([]);
  });
});
