import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { walkSourceFiles } from "./walk-source-files";

const SERVER_ROOT = path.resolve(__dirname, "../../src/server");

// src/lib/rag/local-retrieval.ts transitively imports both
// local-embedder.ts (WASM, browser-only) and local-vector-store.ts
// (IndexedDB, browser-only) — a server import would fail the moment any
// of its functions actually ran. Same enforcement pattern as
// local-embedder-client-only.test.ts and local-vector-store-client-only.test.ts.
const LOCAL_RETRIEVAL_IMPORT = /from\s+["'].*\/local-retrieval["']/;

describe("guard: nothing under src/server/** imports src/lib/rag/local-retrieval", () => {
  it("local RAG retrieval never runs server-side", () => {
    const files = walkSourceFiles(SERVER_ROOT, [".ts", ".tsx"]);

    const violations = files
      .map((file) => ({ file, content: readFileSync(file, "utf8") }))
      .filter(({ content }) => LOCAL_RETRIEVAL_IMPORT.test(content))
      .map(({ file }) => path.relative(process.cwd(), file));

    expect(violations).toEqual([]);
  });
});
