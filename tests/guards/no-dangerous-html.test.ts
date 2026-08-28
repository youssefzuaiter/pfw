import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { walkSourceFiles } from "./walk-source-files";

const SRC_ROOT = path.resolve(__dirname, "../../src");

// One narrow, documented exception: the blocking theme-init script needs
// a literal inline <script> body to run before first paint (avoiding a
// flash of the wrong theme), and JSX has no other way to set a <script>
// tag's text content. It's safe specifically because the content is a
// hardcoded string literal with zero interpolation of any request/user
// data — see that file's doc comment for the full reasoning. Every other
// file must still never use it.
const ALLOWED_FILES = [path.resolve(SRC_ROOT, "components", "theme", "theme-init-script.tsx")];

describe("guard: no dangerouslySetInnerHTML outside the one documented exception", () => {
  it("is never used anywhere in src/ except theme-init-script.tsx", () => {
    const files = walkSourceFiles(SRC_ROOT, [".ts", ".tsx"]).filter((file) => !ALLOWED_FILES.includes(file));
    const violations = files
      .map((file) => ({ file, content: readFileSync(file, "utf8") }))
      .filter(({ content }) => content.includes("dangerouslySetInnerHTML"))
      .map(({ file }) => path.relative(process.cwd(), file));

    expect(violations).toEqual([]);
  });

  it("the one allowed file has no dynamic interpolation in its script body", () => {
    for (const file of ALLOWED_FILES) {
      const content = readFileSync(file, "utf8");
      // The __html value must not be built with a template literal
      // containing `${...}` — that would reintroduce exactly the
      // injection risk this guard exists to prevent.
      const scriptLiteralMatch = content.match(/const THEME_INIT_SCRIPT = `([\s\S]*?)`;/);
      expect(scriptLiteralMatch).not.toBeNull();
      expect(scriptLiteralMatch?.[1]).not.toMatch(/\$\{/);
    }
  });
});
