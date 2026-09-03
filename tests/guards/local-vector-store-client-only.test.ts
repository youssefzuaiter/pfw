import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { walkSourceFiles } from "./walk-source-files";

const SERVER_ROOT = path.resolve(__dirname, "../../src/server");

// src/lib/rag/local-vector-store.ts wraps the real browser `indexedDB`
// global, which doesn't exist under Node — a server import would throw
// the moment any of its functions actually ran, not merely be
// redundant. Same enforcement pattern as local-embedder-client-only.test.ts
// and receipt-ocr-client-only.test.ts.
const LOCAL_VECTOR_STORE_IMPORT = /from\s+["'].*\/local-vector-store["']/;

describe("guard: nothing under src/server/** imports src/lib/rag/local-vector-store", () => {
  it("the local RAG vector cache never runs server-side", () => {
    const files = walkSourceFiles(SERVER_ROOT, [".ts", ".tsx"]);

    const violations = files
      .map((file) => ({ file, content: readFileSync(file, "utf8") }))
      .filter(({ content }) => LOCAL_VECTOR_STORE_IMPORT.test(content))
      .map(({ file }) => path.relative(process.cwd(), file));

    expect(violations).toEqual([]);
  });
});
