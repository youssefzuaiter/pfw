import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { walkSourceFiles } from "./walk-source-files";

const SERVER_ROOT = path.resolve(__dirname, "../../src/server");

// src/lib/pdf-extract.ts wraps pdf.js, which needs a Worker and the DOM
// — neither of which exists server-side — and, more importantly, this
// feature's whole "the PDF never leaves your device" premise
// (AGENTS.md §3bbb) depends on extraction only ever running in the
// browser. A server-side import would quietly turn a local read into an
// upload of the entire statement. Same enforcement pattern as
// tests/guards/zk-client-only.test.ts.
const PDF_EXTRACT_IMPORT = /from\s+["'].*\/pdf-extract["']/;

describe("guard: nothing under src/server/** imports src/lib/pdf-extract", () => {
  it("PDF text extraction never runs server-side", () => {
    const files = walkSourceFiles(SERVER_ROOT, [".ts", ".tsx"]);

    const violations = files
      .map((file) => ({ file, content: readFileSync(file, "utf8") }))
      .filter(({ content }) => PDF_EXTRACT_IMPORT.test(content))
      .map(({ file }) => path.relative(process.cwd(), file));

    expect(violations).toEqual([]);
  });
});
