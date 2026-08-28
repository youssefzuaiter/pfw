import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptField, encryptField } from "./field-encryption";

describe("field-level encryption (AES-256-GCM)", () => {
  const originalKey = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
  });

  afterEach(() => {
    process.env.ENCRYPTION_KEY = originalKey;
  });

  it("round-trips plaintext", () => {
    const plaintext = "Zelle to John Smith — rent, October";
    const stored = encryptField(plaintext);
    expect(decryptField(stored)).toBe(plaintext);
  });

  it("round-trips Hebrew text", () => {
    const plaintext = "רמי לוי - קניות שבועיות";
    expect(decryptField(encryptField(plaintext))).toBe(plaintext);
  });

  it("never stores the plaintext as a substring of the ciphertext", () => {
    const plaintext = "super-secret-merchant-memo";
    expect(encryptField(plaintext)).not.toContain(plaintext);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const plaintext = "same input";
    expect(encryptField(plaintext)).not.toBe(encryptField(plaintext));
  });

  it("rejects a tampered ciphertext (auth tag mismatch)", () => {
    const stored = encryptField("original");
    const [version, iv, tag, ciphertext] = stored.split(":");
    const tamperedByte = Buffer.from(ciphertext, "base64");
    tamperedByte[0] = tamperedByte[0] ^ 0xff;
    const tampered = [version, iv, tag, tamperedByte.toString("base64")].join(":");

    expect(() => decryptField(tampered)).toThrow();
  });

  it("rejects decryption with the wrong key", () => {
    const stored = encryptField("original");
    process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
    expect(() => decryptField(stored)).toThrow();
  });

  it("rejects a malformed stored value", () => {
    expect(() => decryptField("not-the-right-format")).toThrow(RangeError);
  });

  it("throws when ENCRYPTION_KEY is unset", () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => encryptField("x")).toThrow(/ENCRYPTION_KEY/);
  });

  it("throws when ENCRYPTION_KEY is the wrong length", () => {
    // env.ts's own Zod validation (added for secrets/env hardening) now
    // catches this before getKey()'s RangeError ever gets a chance to
    // fire — both checks still exist (defense in depth: getKey()'s check
    // is what protects a hypothetical future caller that reads
    // ENCRYPTION_KEY some other way, bypassing env.ts entirely), but
    // env.ts's is strictly earlier in the normal path, so this is what
    // actually surfaces here now.
    process.env.ENCRYPTION_KEY = Buffer.from("too-short").toString("base64");
    expect(() => encryptField("x")).toThrow(/ENCRYPTION_KEY/);
  });
});
