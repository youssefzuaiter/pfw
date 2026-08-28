import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { walkSourceFiles } from "./walk-source-files";

const SRC_ROOT = path.resolve(__dirname, "../../src");
const TOKEN_DEFINITION_FILE = path.resolve(SRC_ROOT, "app/globals.css");

// Matches #abc, #abcdef, #abcdef12 — but not longer runs of hex-looking
// characters (e.g. git-style hashes) or URL fragment identifiers like
// `#section` (which contain non-hex letters).
const HEX_LITERAL = /#[0-9a-fA-F]{8}(?![0-9a-fA-F])|#[0-9a-fA-F]{6}(?![0-9a-fA-F])|#[0-9a-fA-F]{3}(?![0-9a-fA-F])/;

describe("guard: no untokenized hex color literals", () => {
  const files = walkSourceFiles(SRC_ROOT, [".ts", ".tsx", ".css"]).filter(
    (file) => file !== TOKEN_DEFINITION_FILE && !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"),
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
