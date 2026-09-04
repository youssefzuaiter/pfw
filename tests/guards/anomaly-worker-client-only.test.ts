import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { walkSourceFiles } from "./walk-source-files";

const SERVER_ROOT = path.resolve(__dirname, "../../src/server");

// src/lib/ml/anomaly-worker.ts, anomaly-client.ts, and
// anomaly-worker-handlers.ts wrap onnxruntime-web, which needs a real
// browser WASM runtime and a Worker — none of which exist server-side,
// and more importantly, this feature's whole "no financial data ever
// leaves the device to run this detector" premise depends on it only
// ever running in the browser. Same enforcement pattern as
// forecaster-client-only.test.ts, local-embedder-client-only.test.ts,
// and zk-client-only.test.ts.
const ANOMALY_WORKER_IMPORT = /from\s+["'].*\/anomaly-(client|worker-handlers)["']/;

describe("guard: nothing under src/server/** imports the client-only spending-anomaly modules", () => {
  it("the spending-anomaly detector never runs server-side", () => {
    const files = walkSourceFiles(SERVER_ROOT, [".ts", ".tsx"]);

    const violations = files
      .map((file) => ({ file, content: readFileSync(file, "utf8") }))
      .filter(({ content }) => ANOMALY_WORKER_IMPORT.test(content))
      .map(({ file }) => path.relative(process.cwd(), file));

    expect(violations).toEqual([]);
  });
});
