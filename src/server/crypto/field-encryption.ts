import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { getEncryptionKey, getEncryptionKeyNext } from "../env";

/**
 * AES-256-GCM field-level encryption for sensitive metadata columns
 * (Section 7 of the spec). Ciphertext format is self-describing and
 * versioned so the algorithm/format can change later without a silent
 * misread of old rows:
 *
 *   v1:<iv base64>:<authTag base64>:<ciphertext base64>            — always ENCRYPTION_KEY
 *   v2:<key id>:<iv base64>:<authTag base64>:<ciphertext base64>   — key-id-tagged, see below
 *
 * This is deliberately a generic string <-> string codec, not tied to
 * Prisma — src/server/db/encrypted-fields.ts is what wires it into the
 * Prisma Client extension for specific model fields.
 *
 * KEY ROTATION (docs/SECURITY-CHECKLIST.md's "Secret rotation & storage
 * guidelines" — this used to be documented there as "not built yet"):
 *
 * `v1:` never changes meaning — it has no key id at all, so it can only
 * ever mean "decrypt with the current `ENCRYPTION_KEY`", exactly as
 * before this rotation support existed. That's actually still correct
 * during a live rotation, not just before one: the instant
 * `ENCRYPTION_KEY_NEXT` is set, `encryptField()` below switches every
 * NEW write to the keyed `v2:` format, so a `v1:` row can only be one
 * that was written *before* the rotation began — i.e. still genuinely
 * under whatever `ENCRYPTION_KEY` has held the whole time. No ambiguity,
 * no format migration needed for the (vast majority of) rows already on
 * disk, and zero behavior change for a deployment that never rotates.
 *
 * `v2:<key id>:...` carries a short, public fingerprint of whichever key
 * encrypted it (`computeKeyId()` below — a one-way hash, not the key
 * itself, the same "hash it, never store the secret" instinct this app
 * already applies to `GroupInvite.tokenHash`/`Beneficiary.shareHash`,
 * just for a key instead of a token). `decryptField()` resolves that id
 * against whichever of `ENCRYPTION_KEY`/`ENCRYPTION_KEY_NEXT` is
 * currently configured and uses whichever one matches — so a `v2:` row
 * stays readable through the entire rotation window regardless of which
 * of the two keys actually encrypted it, and stays readable after the
 * rotation completes too: once the operator sets `ENCRYPTION_KEY` to the
 * new value and removes `ENCRYPTION_KEY_NEXT`, that row's key id now
 * simply matches `ENCRYPTION_KEY` again.
 *
 * `src/server/crypto/key-rotation.ts` is the batch job that actually
 * moves existing rows off `v1:`/an old `v2:` id and onto the new key,
 * during a rotation; this module only defines the format and the
 * per-value encrypt/decrypt operations it's built from.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12; // 96-bit IV is the GCM-recommended size.
const AUTH_TAG_LENGTH_BYTES = 16; // 128-bit tag — matches getAuthTag()'s own default, made explicit below.
const LEGACY_FORMAT_VERSION = "v1";
const KEYED_FORMAT_VERSION = "v2";
// A public fingerprint, not a secret — 6 bytes of SHA-256(key), hex-
// encoded (never base64/base64url: those alphabets include `_`, which is
// a SQL `LIKE` wildcard, and key-rotation.ts's own "which rows are still
// on the old key" query needs an exact, wildcard-free prefix match).
const KEY_ID_LENGTH_BYTES = 6;

function decodeKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new RangeError(
      `ENCRYPTION_KEY must decode (base64) to exactly 32 bytes for AES-256-GCM, got ${key.length}`,
    );
  }
  return key;
}

function getKey(): Buffer {
  return decodeKey(getEncryptionKey());
}

function computeKeyId(key: Buffer): string {
  return createHash("sha256").update(key).digest().subarray(0, KEY_ID_LENGTH_BYTES).toString("hex");
}

/**
 * The `v2:` key id a fresh `encryptField()` call would tag its output
 * with right now — i.e. the fingerprint of whichever key is currently
 * "active" for new writes. `null` when no rotation is in progress (a
 * non-rotating write stays on the legacy `v1:` format and carries no key
 * id at all, so there's nothing to report). Exists for
 * `src/server/crypto/key-rotation.ts`'s own "which rows still need
 * re-encrypting" query.
 */
export function getActiveEncryptionKeyId(): string | null {
  const nextEncoded = getEncryptionKeyNext();
  return nextEncoded ? computeKeyId(decodeKey(nextEncoded)) : null;
}

/**
 * The fingerprints of both configured keys — `current` for
 * `ENCRYPTION_KEY`, `next` for `ENCRYPTION_KEY_NEXT` (`null` outside a
 * rotation). Reported by `GET /api/cron` so an operator can confirm, BEFORE
 * cutting `ENCRYPTION_KEY` over to the new value, that the copy on file (the
 * password manager's) is byte-for-byte the key production rows are actually
 * under: `printf '%s' "$KEY" | base64 -d | shasum -a 256 | cut -c1-12` on
 * the stored copy must print `next`. Cutting over on a mismatched copy would
 * leave every re-keyed row behind a key nobody holds — the one failure
 * `resolveKeyForId`'s error below can name but not undo. A fingerprint is
 * derivable from a key, never the reverse, and every `v2:` row already
 * carries one in plaintext, so this reveals nothing a stored row doesn't.
 */
export function getEncryptionKeyFingerprints(): { current: string; next: string | null } {
  return { current: computeKeyId(getKey()), next: getActiveEncryptionKeyId() };
}

function decryptWithKey(key: Buffer, ivB64: string, authTagB64: string, ciphertextB64: string): string {
  // authTagLength is explicit, not left to Node's default: without it,
  // setAuthTag() below would accept any GCM-valid tag length (4-16
  // bytes), which is exactly the truncated-tag forgery Semgrep's
  // gcm-no-tag-length rule flags — pinning it to the 16 bytes this
  // module has always produced (encryptField's getAuthTag() call below)
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

function resolveKeyForId(kid: string): Buffer {
  const current = getKey();
  if (computeKeyId(current) === kid) return current;

  const nextEncoded = getEncryptionKeyNext();
  if (nextEncoded) {
    const next = decodeKey(nextEncoded);
    if (computeKeyId(next) === kid) return next;
  }

  throw new RangeError(
    `Ciphertext is tagged with a key id (${kid}) that matches neither the current ENCRYPTION_KEY nor ` +
      "ENCRYPTION_KEY_NEXT — if a rotation just finished, ENCRYPTION_KEY may have been changed before every " +
      "row was re-encrypted onto it (see src/server/crypto/key-rotation.ts).",
  );
}

export function encryptField(plaintext: string): string {
  const nextEncoded = getEncryptionKeyNext();
  const key = nextEncoded ? decodeKey(nextEncoded) : getKey();

  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const parts = [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")];

  // While a rotation is in progress (ENCRYPTION_KEY_NEXT set), every new
  // write goes onto the new key, tagged with its id — see this file's
  // header comment for why that alone is enough for v1: rows to stay
  // unambiguous with no format change of their own.
  if (nextEncoded) {
    return [KEYED_FORMAT_VERSION, computeKeyId(key), ...parts].join(":");
  }
  return [LEGACY_FORMAT_VERSION, ...parts].join(":");
}

export function decryptField(stored: string): string {
  const parts = stored.split(":");
  const version = parts[0];

  if (version === LEGACY_FORMAT_VERSION) {
    if (parts.length !== 4) {
      throw new RangeError(`Unrecognized encrypted-field format: expected "${LEGACY_FORMAT_VERSION}:iv:tag:ciphertext"`);
    }
    return decryptWithKey(getKey(), parts[1], parts[2], parts[3]);
  }

  if (version === KEYED_FORMAT_VERSION) {
    if (parts.length !== 5) {
      throw new RangeError(
        `Unrecognized encrypted-field format: expected "${KEYED_FORMAT_VERSION}:keyId:iv:tag:ciphertext"`,
      );
    }
    const [, kid, ivB64, authTagB64, ciphertextB64] = parts;
    return decryptWithKey(resolveKeyForId(kid), ivB64, authTagB64, ciphertextB64);
  }

  throw new RangeError(
    `Unrecognized encrypted-field format: expected "${LEGACY_FORMAT_VERSION}:iv:tag:ciphertext" or ` +
      `"${KEYED_FORMAT_VERSION}:keyId:iv:tag:ciphertext"`,
  );
}
