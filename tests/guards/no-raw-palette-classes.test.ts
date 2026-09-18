import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { walkSourceFiles } from "./walk-source-files";

const SRC_ROOT = path.resolve(__dirname, "../../src");

/**
 * The companion to `no-untokenized-hex.test.ts` (palette re-tokenization
 * pass, AGENTS.md §3vv). That guard stops a literal `#hex` from bypassing
 * the `--pfw-*` tokens; this one stops the other, quieter route the same
 * drift actually took: Tailwind's built-in palette utilities
 * (`bg-slate-900`, `text-neutral-400`, `ring-sky-400`, …), which contain
 * no hex literal and so sailed past the hex guard while, over one
 * redesign, moving every screen but `/trading` onto a second color
 * system nobody had contrast-verified. §3tt's axe sweep failing ten
 * screens on one such shade is what that cost. Every colour in this
 * app's UI goes through `globals.css`'s tokens (`bg-bg`, `bg-surface`,
 * `bg-elevated`, `text-fg`, `text-muted`, `border-border`, `text-accent`,
 * `ring-ring`, …) — the ones the e2e axe suite and the per-token contrast
 * comments actually cover.
 *
 * Deliberately NOT flagged: `bg-black/NN` — a modal scrim is a true
 * neutral overlay, not a palette choice, and appears nowhere else.
 *
 * Comments are stripped before scanning, so a doc comment may still
 * name a legacy class when explaining what it replaced (this is a
 * guard on code, not on prose — the `focus-visible` guard's history of
 * matching tag names inside comments is exactly the trap avoided here).
 */
const PALETTE_UTILITY =
  /(?:^|[\s"'`{(])(?:[a-z-]+:)*(?:bg|text|border|ring|fill|stroke|from|via|to|divide|outline|shadow|placeholder|accent|caret|decoration)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}(?:\/\d{1,3})?(?![\w-])/;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

describe("guard: no raw Tailwind palette colour utilities", () => {
  const files = walkSourceFiles(SRC_ROOT, [".ts", ".tsx"]).filter(
    (file) => !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"),
  );

  it("finds at least one source file to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("uses only --pfw-* token utilities for colour", () => {
    const violations = files
      .map((file) => ({ file, content: stripComments(readFileSync(file, "utf8")) }))
      .filter(({ content }) => PALETTE_UTILITY.test(content))
      .map(({ file, content }) => {
        const match = content.match(PALETTE_UTILITY);
        return `${path.relative(process.cwd(), file)}: ${match?.[0].trim()}`;
      });

    expect(violations).toEqual([]);
  });

  it("recognises the shapes it exists to catch (self-test)", () => {
    expect(PALETTE_UTILITY.test('className="rounded-md bg-slate-800 text-slate-100"')).toBe(true);
    expect(PALETTE_UTILITY.test('"hover:bg-slate-700 focus-visible:ring-sky-400"')).toBe(true);
    expect(PALETTE_UTILITY.test('"border-slate-800/80"')).toBe(true);
    expect(PALETTE_UTILITY.test('"bg-bg text-muted border-border ring-ring bg-elevated"')).toBe(false);
    expect(PALETTE_UTILITY.test('"fixed inset-0 bg-black/40"')).toBe(false);
    expect(PALETTE_UTILITY.test(stripComments("/* was `bg-slate-900` before */ const x = 1;"))).toBe(false);
  });
});
