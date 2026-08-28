import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const GLOBALS_CSS = path.resolve(__dirname, "../../src/app/globals.css");

describe("guard: prefers-reduced-motion is respected globally", () => {
  const css = readFileSync(GLOBALS_CSS, "utf8");

  it("declares a @media (prefers-reduced-motion: reduce) block", () => {
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });

  it("the reduced-motion block collapses animation and transition durations", () => {
    const block = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\}\s*\}/)?.[1] ?? "";
    expect(block).toMatch(/animation-duration/);
    expect(block).toMatch(/transition-duration/);
  });
});
