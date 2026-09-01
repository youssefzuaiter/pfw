import "server-only";
import type { PrismaClient } from "../../generated/prisma/client";
import { decryptField, encryptField } from "../crypto/field-encryption";

/**
 * Sensitive metadata columns that are AES-256-GCM ciphertext at rest (see
 * src/server/crypto/field-encryption.ts and the schema file header for
 * why these specific fields). Transparent to every other layer: the DAL
 * reads/writes plaintext strings, this extension does the rest.
 *
 * `GoalContribution.note` deliberately does NOT go through this extension
 * (AGENTS.md §3m) — it moved to zero-knowledge client-side encryption
 * (src/lib/zk-crypto.ts), which this server-side codec structurally
 * cannot participate in: the whole point is that the server never holds
 * a key that can decrypt it. If this extension encrypted it too, every
 * write would double-encrypt a value that's already ciphertext, and
 * every read would try to AES-GCM-decrypt a "zk1:..." string with the
 * wrong key/format and throw. A pre-migration row still in the OLD
 * "v1:iv:tag:ciphertext" format is read here as a raw, un-decrypted
 * string too — only `zk-vault.ts`'s one-time migration path is allowed
 * to call `decryptField` on it directly.
 */
const ENCRYPTED_FIELDS = {
  bankAccount: ["last4"],
  notableTransaction: ["description"],
  // A TOTP secret (Punch List Tier 2, item 3) is exactly as sensitive as a
  // password — the same at-rest protection `passwordHash`'s Argon2id
  // hashing gives credentials, applied here to the shared secret itself
  // (which, unlike a password hash, is a genuinely reversible value an
  // attacker with read access to the raw table could otherwise use
  // directly to generate valid codes).
  user: ["totpSecret"],
} as const;

type EncryptedModelKey = keyof typeof ENCRYPTED_FIELDS;

function encryptInPlace(data: unknown, fields: readonly string[]): void {
  if (!data || typeof data !== "object") return;
  const record = data as Record<string, unknown>;
  for (const field of fields) {
    if (typeof record[field] === "string") {
      record[field] = encryptField(record[field] as string);
    }
  }
}

function decryptResult<T>(result: T, fields: readonly string[]): T {
  if (Array.isArray(result)) {
    return result.map((item) => decryptResult(item, fields)) as unknown as T;
  }
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    for (const field of fields) {
      if (typeof record[field] === "string") {
        record[field] = decryptField(record[field] as string);
      }
    }
  }
  return result;
}

type AllOperationsArgs = {
  operation: string;
  args: Record<string, unknown>;
  query: (args: Record<string, unknown>) => Promise<unknown>;
};

function makeAllOperationsHandler(modelKey: EncryptedModelKey) {
  const fields = ENCRYPTED_FIELDS[modelKey];

  return async ({ operation, args, query }: AllOperationsArgs) => {
    switch (operation) {
      case "create":
      case "update":
        encryptInPlace(args.data, fields);
        break;
      case "upsert":
        encryptInPlace(args.create, fields);
        encryptInPlace(args.update, fields);
        break;
      case "createMany":
      case "updateMany":
        // Not used by the DAL for these models today. Fail loudly instead
        // of silently persisting plaintext if that ever changes — batch
        // operations need their own array-aware encrypt step.
        throw new Error(
          `${modelKey}.${operation} is not supported by the field-encryption extension yet`,
        );
      default:
        break;
    }

    const result = await query(args);
    return decryptResult(result, fields);
  };
}

/**
 * Applies transparent field-level encryption to a Prisma Client instance.
 * `src/server/db/client.ts` builds every client through this rather than
 * encrypting/decrypting fields by hand at each DAL call site.
 */
export function withEncryptedFields(client: PrismaClient) {
  return client.$extends({
    name: "encrypted-fields",
    query: {
      bankAccount: { $allOperations: makeAllOperationsHandler("bankAccount") },
      notableTransaction: { $allOperations: makeAllOperationsHandler("notableTransaction") },
      user: { $allOperations: makeAllOperationsHandler("user") },
    },
  });
}
