import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getEncryptionKey } from "../env";

/**
 * AES-256-GCM field-level encryption for sensitive metadata columns
 * (Section 7 of the spec). Ciphertext format is self-describing and
 * versioned so the algorithm/format can change later without a silent
 * misread of old rows:
 *
 *   v1:<iv base64>:<authTag base64>:<ciphertext base64>
 *
 * This is deliberately a generic string <-> string codec, not tied to
 * Prisma — src/server/db/encrypted-fields.ts is what wires it into the
 * Prisma Client extension for specific model fields.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12; // 96-bit IV is the GCM-recommended size.
const AUTH_TAG_LENGTH_BYTES = 16; // 128-bit tag — matches getAuthTag()'s own default, made explicit below.
const FORMAT_VERSION = "v1";

function getKey(): Buffer {
  const encoded = getEncryptionKey();
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new RangeError(
      `ENCRYPTION_KEY must decode (base64) to exactly 32 bytes for AES-256-GCM, got ${key.length}`,
    );
  }
  return key;
}

export function encryptField(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [FORMAT_VERSION, iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(
    ":",
  );
}

export function decryptField(stored: string): string {
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new RangeError(`Unrecognized encrypted-field format: expected "${FORMAT_VERSION}:iv:tag:ciphertext"`);
  }
  const [, ivB64, authTagB64, ciphertextB64] = parts;

  const key = getKey();
  // authTagLength is explicit, not left to Node's default: without it,
  // setAuthTag() below would accept any GCM-valid tag length (4-16
  // bytes), which is exactly the truncated-tag forgery Semgrep's
  // gcm-no-tag-length rule flags — pinning it to the 16 bytes this
  // module has always produced (encryptField's getAuthTag() call above)
  // closes that off with no format/behavior change for real ciphertext.
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"), {
    authTagLength: AUTH_TAG_LENGTH_BYTES,
  });
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
