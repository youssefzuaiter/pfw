import { describe, expect, it } from "vitest";
import {
  DMS_PBKDF2_ITERATIONS,
  deriveVaultKeyBytes,
  encryptVaultValue,
  generateVaultSalt,
  importVaultAesKey,
} from "../../src/lib/dead-mans-switch-crypto";
import { decryptVaultValueNode } from "../../src/server/dead-mans-switch/vault-cipher-node";

/**
 * Lives under tests/integration/, deliberately NOT src/server/, even
 * though it needs no database — importing src/lib/dead-mans-switch-crypto.ts
 * from anywhere under src/server/** would trip
 * tests/guards/dead-mans-switch-crypto-client-only.test.ts, which is
 * exactly the point of that guard (AGENTS.md §3t): key derivation and
 * client-side encryption must only ever happen in the browser. This test
 * proves the two independent AES-256-GCM implementations — WebCrypto
 * client-side, Node crypto server-side — are genuinely byte-compatible,
 * not just similarly-formatted.
 */
describe("decryptVaultValueNode — cross-compatibility with the client-side WebCrypto path", () => {
  it("decrypts ciphertext produced by the real client-side encryptVaultValue", async () => {
    const rawKey = await deriveVaultKeyBytes("household emergency passphrase", generateVaultSalt(), DMS_PBKDF2_ITERATIONS);
    const key = await importVaultAesKey(rawKey);

    const ciphertext = await encryptVaultValue(key, "Will is in the safe at 12 Herzl St. Combination: 12-34-56.");

    expect(decryptVaultValueNode(rawKey, ciphertext)).toBe(
      "Will is in the safe at 12 Herzl St. Combination: 12-34-56.",
    );
  });

  it("round-trips Hebrew text correctly", async () => {
    const rawKey = await deriveVaultKeyBytes("p", generateVaultSalt(), DMS_PBKDF2_ITERATIONS);
    const key = await importVaultAesKey(rawKey);
    const ciphertext = await encryptVaultValue(key, "כספת ביתית [home safe]");
    expect(decryptVaultValueNode(rawKey, ciphertext)).toBe("כספת ביתית [home safe]");
  });

  it("throws for the wrong key (auth tag rejection, not garbage output)", async () => {
    const rawKeyA = await deriveVaultKeyBytes("a", generateVaultSalt(), DMS_PBKDF2_ITERATIONS);
    const rawKeyB = await deriveVaultKeyBytes("b", generateVaultSalt(), DMS_PBKDF2_ITERATIONS);
    const keyA = await importVaultAesKey(rawKeyA);
    const ciphertext = await encryptVaultValue(keyA, "secret");

    expect(() => decryptVaultValueNode(rawKeyB, ciphertext)).toThrow();
  });

  it("throws for a tampered ciphertext", async () => {
    const rawKey = await deriveVaultKeyBytes("p", generateVaultSalt(), DMS_PBKDF2_ITERATIONS);
    const key = await importVaultAesKey(rawKey);
    const ciphertext = await encryptVaultValue(key, "secret");
    const parts = ciphertext.split(":");
    const middle = Math.floor(parts[2].length / 2);
    const flipped = parts[2][middle] === "A" ? "B" : "A";
    parts[2] = parts[2].slice(0, middle) + flipped + parts[2].slice(middle + 1);

    expect(() => decryptVaultValueNode(rawKey, parts.join(":"))).toThrow();
  });

  it("rejects an unrecognized format", () => {
    expect(() => decryptVaultValueNode(new Uint8Array(32), "v1:iv:tag:ciphertext")).toThrow(RangeError);
  });
});
