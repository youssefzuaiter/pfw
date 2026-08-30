import "server-only";
import { createDecipheriv } from "node:crypto";

/**
 * Node-crypto companion to src/lib/dead-mans-switch-crypto.ts's "dms1:"
 * AES-256-GCM format (AGENTS.md §3t) — decrypt only, no encrypt/derive
 * here, because this file's entire reason to exist is the ONE moment
 * recovery-service.ts needs it: the server has just reconstructed the
 * vault master key from combined Shamir shares and needs to decrypt
 * EmergencyDocument rows to hand back to a beneficiary, in that single
 * response, without persisting the plaintext or the key anywhere (the
 * same "one deliberate, one-time, documented exposure" pattern
 * `findLegacyNoteContributions` already established for the zero-
 * knowledge vault's legacy-note migration, §3m).
 *
 * WebCrypto's AES-GCM (used client-side) appends its 16-byte auth tag to
 * the end of the ciphertext; Node's `createDecipheriv` wants the tag
 * split out and passed to `setAuthTag` separately — this function does
 * that split, so the two implementations are genuinely byte-compatible
 * (proven by this file's own test: ciphertext produced by the real
 * client-side WebCrypto path decrypts correctly here, not just "the
 * format string looks similar").
 *
 * This module intentionally does NOT import src/lib/dead-mans-switch-crypto.ts
 * — see tests/guards/dead-mans-switch-crypto-client-only.test.ts, which
 * would fail the build if it did.
 */

const ALGORITHM = "aes-256-gcm";
const FORMAT_VERSION = "dms1";
const AUTH_TAG_LENGTH_BYTES = 16;

function fromBase64(base64: string): Buffer {
  return Buffer.from(base64, "base64");
}

/** Throws (auth-tag failure, or an unrecognized format) if `rawKeyBytes` is wrong or `stored` was tampered with — same failure shape as the client-side `decryptVaultValue`. */
export function decryptVaultValueNode(rawKeyBytes: Uint8Array, stored: string): string {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== FORMAT_VERSION) {
    throw new RangeError(`Unrecognized vault ciphertext format: expected "${FORMAT_VERSION}:iv:ciphertext"`);
  }
  const [, ivB64, ciphertextAndTagB64] = parts;

  const iv = fromBase64(ivB64);
  const ciphertextAndTag = fromBase64(ciphertextAndTagB64);
  if (ciphertextAndTag.length < AUTH_TAG_LENGTH_BYTES) {
    throw new RangeError("Vault ciphertext is too short to contain a GCM auth tag");
  }
  const ciphertext = ciphertextAndTag.subarray(0, ciphertextAndTag.length - AUTH_TAG_LENGTH_BYTES);
  const authTag = ciphertextAndTag.subarray(ciphertextAndTag.length - AUTH_TAG_LENGTH_BYTES);

  const decipher = createDecipheriv(ALGORITHM, Buffer.from(rawKeyBytes), iv);
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}
