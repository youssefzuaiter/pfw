import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { walkSourceFiles } from "./walk-source-files";

const SERVER_ROOT = path.resolve(__dirname, "../../src/server");

// src/lib/zk-crypto.ts derives the zero-knowledge master key from a user's
// passphrase and performs the encrypt/decrypt that must only ever happen in
// the browser (AGENTS.md §3m) — the whole point of "zero-knowledge" is that
// the server never has the ability to do this. Unlike the admin-client
// guard (admin-client-boundary.test.ts), there is no legitimate exception:
// no file under src/server/** may import this module, ever.
const ZK_CRYPTO_IMPORT = /from\s+["'].*\/zk-crypto["']/;

describe("guard: nothing under src/server/** imports src/lib/zk-crypto", () => {
  it("zero-knowledge key derivation and encryption never runs server-side", () => {
    const files = walkSourceFiles(SERVER_ROOT, [".ts", ".tsx"]);

    const violations = files
      .map((file) => ({ file, content: readFileSync(file, "utf8") }))
      .filter(({ content }) => ZK_CRYPTO_IMPORT.test(content))
      .map(({ file }) => path.relative(process.cwd(), file));

    expect(violations).toEqual([]);
  });
});
