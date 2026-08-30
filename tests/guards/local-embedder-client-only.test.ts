import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { walkSourceFiles } from "./walk-source-files";

const SERVER_ROOT = path.resolve(__dirname, "../../src/server");

// src/lib/embeddings/local-embedder.ts wraps Transformers.js, which needs
// a real browser WASM runtime and downloads a multi-MB model — none of
// which belong server-side, and more importantly, this feature's whole
// "no transaction text leaves the device to compute an embedding"
// premise (AGENTS.md §3u) depends on it only ever running in the
// browser. Same enforcement pattern as receipt-ocr-client-only.test.ts
// and zk-client-only.test.ts.
const LOCAL_EMBEDDER_IMPORT = /from\s+["'].*\/local-embedder["']/;

describe("guard: nothing under src/server/** imports src/lib/embeddings/local-embedder", () => {
  it("local semantic embedding never runs server-side", () => {
    const files = walkSourceFiles(SERVER_ROOT, [".ts", ".tsx"]);

    const violations = files
      .map((file) => ({ file, content: readFileSync(file, "utf8") }))
      .filter(({ content }) => LOCAL_EMBEDDER_IMPORT.test(content))
      .map(({ file }) => path.relative(process.cwd(), file));

    expect(violations).toEqual([]);
  });
});
