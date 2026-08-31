import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { walkSourceFiles } from "./walk-source-files";

const SERVER_ROOT = path.resolve(__dirname, "../../src/server");

// src/workers/forecaster.worker.ts, forecaster-client.ts, and
// forecaster-worker-handlers.ts wrap onnxruntime-web, which needs a real
// browser WASM runtime and a Worker — none of which exist server-side,
// and more importantly, this feature's whole "no financial data ever
// leaves the device to compute this forecast" premise (AGENTS.md §3dd)
// depends on it only ever running in the browser. Same enforcement
// pattern as local-embedder-client-only.test.ts, receipt-ocr-client-only.test.ts,
// and zk-client-only.test.ts.
const FORECASTER_IMPORT = /from\s+["'].*\/forecaster(-client|-worker-handlers)?["']/;

describe("guard: nothing under src/server/** imports the client-only forecaster modules", () => {
  it("the cash-flow forecaster never runs server-side", () => {
    const files = walkSourceFiles(SERVER_ROOT, [".ts", ".tsx"]);

    const violations = files
      .map((file) => ({ file, content: readFileSync(file, "utf8") }))
      .filter(({ content }) => FORECASTER_IMPORT.test(content))
      .map(({ file }) => path.relative(process.cwd(), file));

    expect(violations).toEqual([]);
  });
});
