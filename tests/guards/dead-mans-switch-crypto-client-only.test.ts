import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { walkSourceFiles } from "./walk-source-files";

const SERVER_ROOT = path.resolve(__dirname, "../../src/server");

// src/lib/dead-mans-switch-crypto.ts derives the Emergency Vault's
// extractable master key and performs client-side document
// encryption/decryption (AGENTS.md §3t) — key DERIVATION and
// ENCRYPTION must only ever happen in the browser, mirroring
// zk-client-only.test.ts's guard on src/lib/zk-crypto.ts. Unlike that
// module, this vault's key is DESIGNED to be reconstructed server-side
// during a successful recovery (see RecoveryShareSubmission's model
// comment) — but that reconstruction and the matching document
// decryption go through a separate, Node-crypto-based companion,
// src/server/dead-mans-switch/vault-cipher-node.ts, which produces
// byte-compatible output for this module's "dms1:" format without ever
// importing this module itself. No file under src/server/** may import
// this module, ever.
const DMS_CRYPTO_IMPORT = /from\s+["'].*\/dead-mans-switch-crypto["']/;

describe("guard: nothing under src/server/** imports src/lib/dead-mans-switch-crypto", () => {
  it("Emergency Vault key derivation and client-side encryption never run server-side", () => {
    const files = walkSourceFiles(SERVER_ROOT, [".ts", ".tsx"]);

    const violations = files
      .map((file) => ({ file, content: readFileSync(file, "utf8") }))
      .filter(({ content }) => DMS_CRYPTO_IMPORT.test(content))
      .map(({ file }) => path.relative(process.cwd(), file));

    expect(violations).toEqual([]);
  });
});
