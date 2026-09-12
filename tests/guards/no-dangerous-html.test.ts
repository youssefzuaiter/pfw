import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { walkSourceFiles } from "./walk-source-files";

const SRC_ROOT = path.resolve(__dirname, "../../src");

// Previously had one narrow, documented exception (the blocking
// theme-init script's literal, zero-interpolation inline <script> body)
// — that file was deleted along with the whole theme-toggle mechanism
// (ad hoc, at explicit user request), so there is no longer any allowed
// use of dangerouslySetInnerHTML anywhere in this app.
describe("guard: no dangerouslySetInnerHTML anywhere in src/", () => {
  it("is never used anywhere in src/", () => {
    const files = walkSourceFiles(SRC_ROOT, [".ts", ".tsx"]);
    const violations = files
      .map((file) => ({ file, content: readFileSync(file, "utf8") }))
      .filter(({ content }) => content.includes("dangerouslySetInnerHTML"))
      .map(({ file }) => path.relative(process.cwd(), file));

    expect(violations).toEqual([]);
  });
});
