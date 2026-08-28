import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { walkSourceFiles } from "./walk-source-files";

const SRC_ROOT = path.resolve(__dirname, "../../src");

// Heuristic, not a full JSX parse: captures a <button ...> or <a ...>
// opening tag (including multi-line attributes) and checks its className
// for a focus-visible ring utility. Interactive elements built as custom
// components (e.g. a future <Button />) are out of scope for this regex
// and should be covered by a component-level test instead.
//
// Known false-positive trap: an inline arrow-function prop on a scanned
// tag (e.g. `onClick={() => foo()}`) contains a literal `>` from `=>`,
// which this regex's `[^>]*` reads as the tag's own closing bracket —
// truncating the captured attrs before a className that appears after
// it. Prefer a named handler function over an inline arrow on <button>/
// <a> tags (it also reads better) rather than fighting this regex.
const OPENING_TAG = /<(button|a)\b([^>]*)>/g;
const HAS_CLASS_NAME = /className\s*=\s*(?:"([^"]*)"|\{`([^`]*)`\})/;
const HAS_FOCUS_VISIBLE_RING = /focus-visible:ring/;

describe("guard: interactive elements keep a visible focus ring", () => {
  it("every <button> and <a> in src/ carries a focus-visible:ring className", () => {
    const files = walkSourceFiles(SRC_ROOT, [".tsx"]).filter(
      (file) => !file.endsWith(".test.tsx"),
    );

    const violations: string[] = [];

    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const match of content.matchAll(OPENING_TAG)) {
        const [, tag, attrs] = match;
        const classNameMatch = attrs.match(HAS_CLASS_NAME);
        const className = classNameMatch?.[1] ?? classNameMatch?.[2] ?? "";
        if (!HAS_FOCUS_VISIBLE_RING.test(className)) {
          violations.push(`${path.relative(process.cwd(), file)}: <${tag}> missing focus-visible:ring`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
