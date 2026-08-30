import "server-only";
import { z } from "zod";

/**
 * Server-side shape validation for the Cryptographic Dead Man's Switch
 * (AGENTS.md §3t) — same "the server can't verify cryptographic
 * correctness, but it can and must validate shape" treatment
 * src/server/api/zk-validation.ts already gives the zero-knowledge
 * vault. `DMS_MIN_PBKDF2_ITERATIONS` deliberately duplicates
 * src/lib/dead-mans-switch-crypto.ts's DMS_PBKDF2_ITERATIONS rather than
 * importing it — that module must never be imported from
 * `src/server/**` (tests/guards/dead-mans-switch-crypto-client-only.test.ts).
 */

export const DMS_MIN_PBKDF2_ITERATIONS = 600_000;

const BASE64_PATTERN = /^[A-Za-z0-9+/]+=*$/;

export const VaultSaltSchema = z.string().min(8).max(128).regex(BASE64_PATTERN, "must be base64");

/** `dms1:<iv base64>:<ciphertext base64>` — see dead-mans-switch-crypto.ts's format comment. */
export const VaultCiphertextSchema = z
  .string()
  .min(1)
  .max(20_000)
  .regex(/^dms1:[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/, "must be a Dead Man's Switch (dms1:) ciphertext blob");

export const VaultIterationsSchema = z.number().int().min(DMS_MIN_PBKDF2_ITERATIONS).max(10_000_000);

/** SHA-256 hex digest — used for both a share's hash and an invite token's hash. */
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, "must be a SHA-256 hex digest");

export const BeneficiaryLabelSchema = z.string().trim().min(1).max(200);

export const DocumentTitleSchema = z.string().trim().min(1).max(200);

/** `dms-share1:<index>:<base64url value>:<base64url checksum>` — see shamir-secret-sharing.ts's encodeShare. Bounded generously above a 32-byte AES key's encoded share length. */
export const EncodedShareSchema = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .regex(/^dms-share1:\d{1,3}:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/, "must be a Dead Man's Switch share (dms-share1:) string");

export const SetupBeneficiarySchema = z.object({
  label: BeneficiaryLabelSchema,
  shareIndex: z.number().int().min(1).max(255),
  shareHash: Sha256HexSchema,
  inviteTokenHash: Sha256HexSchema,
});

export const SetupDocumentSchema = z.object({
  title: DocumentTitleSchema,
  ciphertext: VaultCiphertextSchema,
});

export const SetupVaultBodySchema = z
  .object({
    salt: VaultSaltSchema,
    iterations: VaultIterationsSchema,
    canaryCiphertext: VaultCiphertextSchema,
    totalShares: z.number().int().min(2).max(255),
    thresholdShares: z.number().int().min(2).max(255),
    inactivityThresholdDays: z.number().int().min(1).max(3650),
    gracePeriodDays: z.number().int().min(1).max(3650),
    beneficiaries: z.array(SetupBeneficiarySchema).min(2).max(255),
    documents: z.array(SetupDocumentSchema).max(50),
  })
  .refine((body) => body.thresholdShares <= body.totalShares, {
    message: "thresholdShares must not exceed totalShares",
    path: ["thresholdShares"],
  })
  .refine((body) => body.beneficiaries.length === body.totalShares, {
    message: "beneficiaries.length must equal totalShares",
    path: ["beneficiaries"],
  });
