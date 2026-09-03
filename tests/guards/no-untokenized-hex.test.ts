import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { walkSourceFiles } from "./walk-source-files";

const SRC_ROOT = path.resolve(__dirname, "../../src");
const TOKEN_DEFINITION_FILE = path.resolve(SRC_ROOT, "app/globals.css");

/**
 * Outbound HTML email (auth hardening pass, ad hoc post-§3ff) —
 * `src/server/email/auth-emails.ts` renders in third-party mail clients,
 * not this app's own themed pages, so it has no access to
 * `globals.css`'s CSS custom properties at all (most mail clients strip
 * or inconsistently support them) — literal hex values are the only
 * correct choice there, standard practice for transactional-email HTML.
 * This app's own themed UI still goes through `--pfw-*` tokens
 * exclusively; this is the one legitimate exception, not a loophole.
 */
const ALLOWED_HEX_FILES = [path.resolve(SRC_ROOT, "server/email/auth-emails.ts")];

// Matches #abc, #abcdef, #abcdef12 — but not longer runs of hex-looking
// characters (e.g. git-style hashes) or URL fragment identifiers like
// `#section` (which contain non-hex letters).
const HEX_LITERAL = /#[0-9a-fA-F]{8}(?![0-9a-fA-F])|#[0-9a-fA-F]{6}(?![0-9a-fA-F])|#[0-9a-fA-F]{3}(?![0-9a-fA-F])/;

describe("guard: no untokenized hex color literals", () => {
  const files = walkSourceFiles(SRC_ROOT, [".ts", ".tsx", ".css"]).filter(
    (file) =>
      file !== TOKEN_DEFINITION_FILE &&
      !ALLOWED_HEX_FILES.includes(file) &&
      !file.endsWith(".test.ts") &&
      !file.endsWith(".test.tsx"),
  );

  it("finds at least one source file to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("contains no raw hex color literals outside globals.css", () => {
    const violations = files
      .map((file) => ({ file, content: readFileSync(file, "utf8") }))
      .filter(({ content }) => HEX_LITERAL.test(content))
      .map(({ file }) => path.relative(process.cwd(), file));

    expect(violations).toEqual([]);
  });
});
