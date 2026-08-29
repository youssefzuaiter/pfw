import { describe, expect, it } from "vitest";
import {
  PBKDF2_ITERATIONS,
  ZK_CANARY_PLAINTEXT,
  decryptWithZkKey,
  deriveZkKey,
  encryptWithZkKey,
  generateZkSalt,
  isZkCiphertext,
  verifyZkKey,
} from "./zk-crypto";

describe("zk-crypto", () => {
  it("round-trips plaintext through encrypt/decrypt with the same derived key", async () => {
    const salt = generateZkSalt();
    const key = await deriveZkKey("correct horse battery staple", salt, PBKDF2_ITERATIONS);

    const ciphertext = await encryptWithZkKey(key, "hospital fund [קרן אשפוז]");
    expect(await decryptWithZkKey(key, ciphertext)).toBe("hospital fund [קרן אשפוז]");
  });

  it("produces a format-versioned, non-plaintext ciphertext", async () => {
    const salt = generateZkSalt();
    const key = await deriveZkKey("passphrase", salt, PBKDF2_ITERATIONS);
    const ciphertext = await encryptWithZkKey(key, "a secret note");

    expect(ciphertext.startsWith("zk1:")).toBe(true);
    expect(ciphertext).not.toContain("a secret note");
    expect(isZkCiphertext(ciphertext)).toBe(true);
  });

  it("derives the identical key from the same passphrase, salt, and iteration count", async () => {
    const salt = generateZkSalt();
    const keyA = await deriveZkKey("same passphrase", salt, PBKDF2_ITERATIONS);
    const keyB = await deriveZkKey("same passphrase", salt, PBKDF2_ITERATIONS);

    const ciphertext = await encryptWithZkKey(keyA, "shared secret");
    expect(await decryptWithZkKey(keyB, ciphertext)).toBe("shared secret");
  });

  it("fails to decrypt with a key derived from the wrong passphrase", async () => {
    const salt = generateZkSalt();
    const rightKey = await deriveZkKey("right passphrase", salt, PBKDF2_ITERATIONS);
    const wrongKey = await deriveZkKey("wrong passphrase", salt, PBKDF2_ITERATIONS);

    const ciphertext = await encryptWithZkKey(rightKey, "secret");
    await expect(decryptWithZkKey(wrongKey, ciphertext)).rejects.toThrow();
  });

  it("fails to decrypt with a key derived from a different salt", async () => {
    const key1 = await deriveZkKey("passphrase", generateZkSalt(), PBKDF2_ITERATIONS);
    const key2 = await deriveZkKey("passphrase", generateZkSalt(), PBKDF2_ITERATIONS);

    const ciphertext = await encryptWithZkKey(key1, "secret");
    await expect(decryptWithZkKey(key2, ciphertext)).rejects.toThrow();
  });

  it("produces two different ciphertexts for the same plaintext (random IV per call)", async () => {
    const key = await deriveZkKey("passphrase", generateZkSalt(), PBKDF2_ITERATIONS);
    const a = await encryptWithZkKey(key, "same note");
    const b = await encryptWithZkKey(key, "same note");

    expect(a).not.toBe(b);
    expect(await decryptWithZkKey(key, a)).toBe("same note");
    expect(await decryptWithZkKey(key, b)).toBe("same note");
  });

  it("detects tampering via the AES-GCM auth tag", async () => {
    const key = await deriveZkKey("passphrase", generateZkSalt(), PBKDF2_ITERATIONS);
    const ciphertext = await encryptWithZkKey(key, "secret");

    const [version, iv, body] = ciphertext.split(":");
    const tampered = [version, iv, body.slice(0, -4) + (body.at(-4) === "A" ? "B" : "A") + body.slice(-3)].join(":");

    await expect(decryptWithZkKey(key, tampered)).rejects.toThrow();
  });

  it("rejects a malformed or legacy-format ciphertext without attempting to decrypt", async () => {
    const key = await deriveZkKey("passphrase", generateZkSalt(), PBKDF2_ITERATIONS);

    await expect(decryptWithZkKey(key, "not-a-ciphertext")).rejects.toThrow(/Unrecognized/);
    // The old server-side field-encryption.ts format — 4 segments, "v1" version.
    await expect(decryptWithZkKey(key, "v1:aWQ=:aWQ=:aWQ=")).rejects.toThrow(/Unrecognized/);
    expect(isZkCiphertext("v1:aWQ=:aWQ=:aWQ=")).toBe(false);
  });

  it("verifyZkKey confirms a correct passphrase against a stored canary", async () => {
    const salt = generateZkSalt();
    const key = await deriveZkKey("my passphrase", salt, PBKDF2_ITERATIONS);
    const canary = await encryptWithZkKey(key, ZK_CANARY_PLAINTEXT);

    const reDerivedKey = await deriveZkKey("my passphrase", salt, PBKDF2_ITERATIONS);
    expect(await verifyZkKey(reDerivedKey, canary)).toBe(true);
  });

  it("verifyZkKey rejects an incorrect passphrase without throwing", async () => {
    const salt = generateZkSalt();
    const key = await deriveZkKey("my passphrase", salt, PBKDF2_ITERATIONS);
    const canary = await encryptWithZkKey(key, ZK_CANARY_PLAINTEXT);

    const wrongKey = await deriveZkKey("not my passphrase", salt, PBKDF2_ITERATIONS);
    await expect(verifyZkKey(wrongKey, canary)).resolves.toBe(false);
  });

  it("generateZkSalt produces distinct salts on repeated calls", () => {
    const salts = new Set(Array.from({ length: 20 }, () => generateZkSalt()));
    expect(salts.size).toBe(20);
  });
});
