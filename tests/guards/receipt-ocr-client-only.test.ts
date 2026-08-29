import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { walkSourceFiles } from "./walk-source-files";

const SERVER_ROOT = path.resolve(__dirname, "../../src/server");

// src/lib/receipt-ocr.ts wraps Tesseract.js, which needs a Worker, WASM,
// and the DOM — none of which exist server-side, and more importantly,
// this feature's whole "the image never leaves your device" premise
// (AGENTS.md §3q) depends on OCR only ever running in the browser. Same
// enforcement pattern as tests/guards/zk-client-only.test.ts.
const RECEIPT_OCR_IMPORT = /from\s+["'].*\/receipt-ocr["']/;

describe("guard: nothing under src/server/** imports src/lib/receipt-ocr", () => {
  it("receipt OCR never runs server-side", () => {
    const files = walkSourceFiles(SERVER_ROOT, [".ts", ".tsx"]);

    const violations = files
      .map((file) => ({ file, content: readFileSync(file, "utf8") }))
      .filter(({ content }) => RECEIPT_OCR_IMPORT.test(content))
      .map(({ file }) => path.relative(process.cwd(), file));

    expect(violations).toEqual([]);
  });
});
