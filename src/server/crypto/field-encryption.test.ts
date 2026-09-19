import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptField, encryptField, getActiveEncryptionKeyId } from "./field-encryption";

describe("field-level encryption (AES-256-GCM)", () => {
  const originalKey = process.env.ENCRYPTION_KEY;
  const originalNextKey = process.env.ENCRYPTION_KEY_NEXT;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
    delete process.env.ENCRYPTION_KEY_NEXT;
  });

  afterEach(() => {
    process.env.ENCRYPTION_KEY = originalKey;
    if (originalNextKey === undefined) delete process.env.ENCRYPTION_KEY_NEXT;
    else process.env.ENCRYPTION_KEY_NEXT = originalNextKey;
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

describe("field-level encryption — ENCRYPTION_KEY_NEXT rotation", () => {
  const originalKey = process.env.ENCRYPTION_KEY;
  const originalNextKey = process.env.ENCRYPTION_KEY_NEXT;
  let oldKey: string;
  let newKey: string;

  beforeEach(() => {
    oldKey = randomBytes(32).toString("base64");
    newKey = randomBytes(32).toString("base64");
    process.env.ENCRYPTION_KEY = oldKey;
    delete process.env.ENCRYPTION_KEY_NEXT;
  });

  afterEach(() => {
    process.env.ENCRYPTION_KEY = originalKey;
    if (originalNextKey === undefined) delete process.env.ENCRYPTION_KEY_NEXT;
    else process.env.ENCRYPTION_KEY_NEXT = originalNextKey;
  });

  it("getActiveEncryptionKeyId() is null when no rotation is in progress", () => {
    expect(getActiveEncryptionKeyId()).toBeNull();
  });

  it("keeps writing the legacy v1 format when ENCRYPTION_KEY_NEXT is unset (no behavior change)", () => {
    const stored = encryptField("no rotation happening");
    expect(stored.startsWith("v1:")).toBe(true);
    expect(stored.split(":")).toHaveLength(4);
  });

  it("switches new writes to the keyed v2 format the instant ENCRYPTION_KEY_NEXT is set", () => {
    process.env.ENCRYPTION_KEY_NEXT = newKey;
    const stored = encryptField("mid-rotation write");
    expect(stored.startsWith("v2:")).toBe(true);
    expect(stored.split(":")).toHaveLength(5);
    expect(decryptField(stored)).toBe("mid-rotation write");
  });

  it("getActiveEncryptionKeyId() reports the new key's id once ENCRYPTION_KEY_NEXT is set", () => {
    process.env.ENCRYPTION_KEY_NEXT = newKey;
    const kid = getActiveEncryptionKeyId();
    expect(kid).not.toBeNull();
    const stored = encryptField("x");
    expect(stored).toContain(`v2:${kid}:`);
  });

  it("a pre-rotation v1 row stays fully readable once a rotation starts", () => {
    const preRotation = encryptField("written before the rotation began");
    expect(preRotation.startsWith("v1:")).toBe(true);

    process.env.ENCRYPTION_KEY_NEXT = newKey;
    expect(decryptField(preRotation)).toBe("written before the rotation began");
  });

  it("a v2 row minted mid-rotation stays readable after the rotation completes (ENCRYPTION_KEY flipped, ENCRYPTION_KEY_NEXT removed)", () => {
    process.env.ENCRYPTION_KEY_NEXT = newKey;
    const midRotation = encryptField("written during the rotation window");

    // The operator's actual completion step: swap the keys, drop NEXT.
    process.env.ENCRYPTION_KEY = newKey;
    delete process.env.ENCRYPTION_KEY_NEXT;

    expect(decryptField(midRotation)).toBe("written during the rotation window");
  });

  it("throws a clear error for a v2 row whose key id matches neither configured key (the old key was removed too early)", () => {
    process.env.ENCRYPTION_KEY_NEXT = newKey;
    const midRotation = encryptField("orphaned");

    // Simulates finishing the rotation onto a THIRD key without ever
    // re-encrypting this row — the exact misconfiguration the key-id
    // check exists to fail loudly on, rather than silently corrupting.
    process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
    delete process.env.ENCRYPTION_KEY_NEXT;

    expect(() => decryptField(midRotation)).toThrow(/key id.*matches neither/);
  });

  it("rejects a v2-format value with the wrong number of segments", () => {
    expect(() => decryptField("v2:onlyonefield")).toThrow(RangeError);
  });
});
