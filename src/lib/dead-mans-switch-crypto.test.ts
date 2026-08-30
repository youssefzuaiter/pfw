import { describe, expect, it } from "vitest";
import {
  DMS_CANARY_PLAINTEXT,
  DMS_KEY_LENGTH_BYTES,
  DMS_PBKDF2_ITERATIONS,
  assertValidShareConfig,
  decryptVaultValue,
  deriveVaultKeyBytes,
  encryptVaultValue,
  generateVaultSalt,
  importVaultAesKey,
  verifyVaultKey,
} from "./dead-mans-switch-crypto";
import { combineShares, splitSecret } from "./shamir-secret-sharing";

describe("dead-mans-switch-crypto", () => {
  it("derives exactly DMS_KEY_LENGTH_BYTES of raw key material", async () => {
    const salt = generateVaultSalt();
    const bytes = await deriveVaultKeyBytes("a recovery passphrase", salt, DMS_PBKDF2_ITERATIONS);
    expect(bytes.length).toBe(DMS_KEY_LENGTH_BYTES);
  });

  it("is deterministic for the same passphrase/salt/iterations", async () => {
    const salt = generateVaultSalt();
    const a = await deriveVaultKeyBytes("same passphrase", salt, DMS_PBKDF2_ITERATIONS);
    const b = await deriveVaultKeyBytes("same passphrase", salt, DMS_PBKDF2_ITERATIONS);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("produces different key bytes for different salts", async () => {
    const a = await deriveVaultKeyBytes("same passphrase", generateVaultSalt(), DMS_PBKDF2_ITERATIONS);
    const b = await deriveVaultKeyBytes("same passphrase", generateVaultSalt(), DMS_PBKDF2_ITERATIONS);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it("round-trips plaintext through encrypt/decrypt with the same imported key", async () => {
    const salt = generateVaultSalt();
    const rawKey = await deriveVaultKeyBytes("correct horse battery staple", salt, DMS_PBKDF2_ITERATIONS);
    const key = await importVaultAesKey(rawKey);

    const ciphertext = await encryptVaultValue(key, "safe deposit box #42 at Bank Leumi [בנק לאומי], key under the lamp");
    expect(await decryptVaultValue(key, ciphertext)).toBe(
      "safe deposit box #42 at Bank Leumi [בנק לאומי], key under the lamp",
    );
  });

  it("rejects import of key bytes with the wrong length", async () => {
    await expect(importVaultAesKey(new Uint8Array(16))).rejects.toThrow(RangeError);
  });

  it("decrypt throws (does not silently return garbage) for a wrong key", async () => {
    const keyA = await importVaultAesKey(await deriveVaultKeyBytes("passphrase A", generateVaultSalt(), DMS_PBKDF2_ITERATIONS));
    const keyB = await importVaultAesKey(await deriveVaultKeyBytes("passphrase B", generateVaultSalt(), DMS_PBKDF2_ITERATIONS));

    const ciphertext = await encryptVaultValue(keyA, "secret");
    await expect(decryptVaultValue(keyB, ciphertext)).rejects.toThrow();
  });

  it("decrypt throws on a tampered ciphertext (GCM auth tag)", async () => {
    const key = await importVaultAesKey(await deriveVaultKeyBytes("p", generateVaultSalt(), DMS_PBKDF2_ITERATIONS));
    const ciphertext = await encryptVaultValue(key, "secret");
    const parts = ciphertext.split(":");
    const tampered = parts[0] + ":" + parts[1] + ":" + (parts[2].slice(0, -2) + (parts[2].at(-2) === "A" ? "BB" : "AA"));
    await expect(decryptVaultValue(key, tampered)).rejects.toThrow();
  });

  it("decrypt rejects an unrecognized format", async () => {
    const key = await importVaultAesKey(await deriveVaultKeyBytes("p", generateVaultSalt(), DMS_PBKDF2_ITERATIONS));
    await expect(decryptVaultValue(key, "v1:not:a:dms:value")).rejects.toThrow(RangeError);
  });

  it("verifyVaultKey: true for the correct key against its own canary, false for a wrong key, never throws", async () => {
    const rightKey = await importVaultAesKey(await deriveVaultKeyBytes("right", generateVaultSalt(), DMS_PBKDF2_ITERATIONS));
    const wrongKey = await importVaultAesKey(await deriveVaultKeyBytes("wrong", generateVaultSalt(), DMS_PBKDF2_ITERATIONS));
    const canary = await encryptVaultValue(rightKey, DMS_CANARY_PLAINTEXT);

    expect(await verifyVaultKey(rightKey, canary)).toBe(true);
    expect(await verifyVaultKey(wrongKey, canary)).toBe(false);
  });

  it("end-to-end: split the derived key, recombine via threshold shares, and the reconstructed key still verifies against the canary and decrypts real documents", async () => {
    const salt = generateVaultSalt();
    const rawKey = await deriveVaultKeyBytes("household emergency passphrase", salt, DMS_PBKDF2_ITERATIONS);
    const originalKey = await importVaultAesKey(rawKey);
    const canary = await encryptVaultValue(originalKey, DMS_CANARY_PLAINTEXT);
    const documentCiphertext = await encryptVaultValue(originalKey, "Will is in the safe. Combination: 12-34-56.");

    const shares = splitSecret(rawKey, 5, 3);
    const reconstructedBytes = combineShares([shares[0], shares[2], shares[4]]);
    const reconstructedKey = await importVaultAesKey(reconstructedBytes);

    expect(await verifyVaultKey(reconstructedKey, canary)).toBe(true);
    expect(await decryptVaultValue(reconstructedKey, documentCiphertext)).toBe(
      "Will is in the safe. Combination: 12-34-56.",
    );
  });

  it("end-to-end: an insufficient set of shares never verifies against the canary (never silently decrypts)", async () => {
    const rawKey = await deriveVaultKeyBytes("household emergency passphrase", generateVaultSalt(), DMS_PBKDF2_ITERATIONS);
    const originalKey = await importVaultAesKey(rawKey);
    const canary = await encryptVaultValue(originalKey, DMS_CANARY_PLAINTEXT);

    const shares = splitSecret(rawKey, 5, 3);
    const insufficientBytes = combineShares([shares[0], shares[1]]); // 2 of 3 needed

    // secrets.js-grempe's padding scheme (see shamir-secret-sharing.ts's
    // top comment) means reconstructing from too few shares doesn't
    // reliably come back at the original byte length the way the old
    // hand-rolled per-byte-polynomial scheme did — sometimes it's a
    // same-length wrong key (fails verifyVaultKey), sometimes it's a
    // wrong-length one (importVaultAesKey itself throws first). This
    // mirrors exactly what recovery-service.ts's real server-side
    // reconstruction path already does: attempt it, and treat either
    // outcome as "not verified" — never a crash, never a false positive.
    let verified: boolean;
    try {
      const wrongKey = await importVaultAesKey(insufficientBytes);
      verified = await verifyVaultKey(wrongKey, canary);
    } catch {
      verified = false;
    }
    expect(verified).toBe(false);
  });
});

describe("assertValidShareConfig", () => {
  it("accepts a normal M-of-N configuration", () => {
    expect(() => assertValidShareConfig(5, 3)).not.toThrow();
  });

  it.each([
    [1, 1],
    [256, 3],
    [3, 5],
    [3, 1],
    [3.5, 2],
  ])("rejects totalShares=%p thresholdShares=%p", (total, threshold) => {
    expect(() => assertValidShareConfig(total, threshold)).toThrow();
  });
});
