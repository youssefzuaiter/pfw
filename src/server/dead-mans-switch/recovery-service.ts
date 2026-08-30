import "server-only";
import { createHash } from "node:crypto";
import { decryptField, encryptField } from "../crypto/field-encryption";
import { combineShares, decodeShare } from "../../lib/shamir-secret-sharing";
import { decryptVaultValueNode } from "./vault-cipher-node";
import {
  adminFindBeneficiaryByTokenHash,
  adminGetSwitchWithSubmissions,
  adminMarkRecovered,
  adminUpsertShareSubmission,
} from "./recovery-admin-ops";

/**
 * Orchestrates the beneficiary recovery flow (AGENTS.md §3t) — the one
 * place in this feature where the server actually combines Shamir
 * shares. Deliberately does NOT import src/lib/dead-mans-switch-crypto.ts
 * (would trip its client-only guard); the server-side AES-GCM decrypt it
 * needs instead comes from vault-cipher-node.ts.
 *
 * SECURITY: the moment >= thresholdShares distinct, hash-verified shares
 * have been submitted, this file reconstructs the master key and
 * decrypts every EmergencyDocument in the SAME response — the one
 * deliberate, one-time, documented server-side exposure this whole
 * feature rests on (see RecoveryShareSubmission's and EmergencyDocument's
 * model comments, and findLegacyNoteContributions's doc comment for the
 * precedent, §3m). The reconstructed key and decrypted plaintext are
 * local variables only; nothing here writes either to the database, a
 * log line, or anywhere else this function's return value doesn't
 * already go.
 */

function hashTokenSha256(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export type RecoveryPortalStatus =
  | { found: false }
  | {
      found: true;
      beneficiaryLabel: string;
      switchStatus: "ACTIVE" | "GRACE_PERIOD" | "TRIGGERED" | "RECOVERED";
      thresholdShares: number;
      totalShares: number;
      submittedShareCount: number;
      /** Whether THIS beneficiary's own share has already been recorded — lets the portal show "you've submitted" without revealing who else has. */
      hasSubmitted: boolean;
    };

/**
 * The anonymous, token-scoped status check the recovery portal polls
 * before showing a submission form — deliberately reveals only this one
 * beneficiary's own label and submission state, never the identities or
 * submission status of any OTHER beneficiary on the same switch (privacy
 * for co-beneficiaries who may not know each other).
 */
export async function getRecoveryPortalStatus(rawToken: string): Promise<RecoveryPortalStatus> {
  const beneficiary = await adminFindBeneficiaryByTokenHash(hashTokenSha256(rawToken));
  if (!beneficiary) return { found: false };

  const fresh = await adminGetSwitchWithSubmissions(beneficiary.deadMansSwitchId);
  /* c8 ignore next -- unreachable: the row was just read above via the same relation */
  if (!fresh) return { found: false };

  return {
    found: true,
    beneficiaryLabel: beneficiary.label,
    switchStatus: fresh.status,
    thresholdShares: fresh.thresholdShares,
    totalShares: fresh.totalShares,
    submittedShareCount: fresh.shareSubmissions.length,
    hasSubmitted: fresh.shareSubmissions.some((s) => s.beneficiaryId === beneficiary.id),
  };
}

function hashShareValueSha256(shareValue: Uint8Array): string {
  return createHash("sha256").update(shareValue).digest("hex");
}

export type SubmitShareResult =
  | { status: "invalid_token" }
  | { status: "not_triggered"; switchStatus: "ACTIVE" | "GRACE_PERIOD" | "RECOVERED" }
  | { status: "invalid_share_format" }
  | { status: "share_hash_mismatch" }
  | { status: "already_recovered" }
  | { status: "accepted_pending"; submittedCount: number; thresholdShares: number }
  | { status: "recovered"; documents: { id: string; title: string; plaintext: string }[] }
  | { status: "key_verification_failed" };

/**
 * Accepts one beneficiary's share submission by invite token. Idempotent
 * per-beneficiary via `adminUpsertShareSubmission` — resubmitting (e.g.
 * after a copy/paste mistake, caught client-side by
 * `decodeShare`'s checksum, or a hash mismatch caught here) just
 * overwrites that beneficiary's own stored submission; it never lets one
 * beneficiary count as more than one share toward the threshold, since
 * upsert is keyed on `(deadMansSwitchId, beneficiaryId)`.
 */
export async function submitRecoveryShare(rawToken: string, encodedShare: string): Promise<SubmitShareResult> {
  const beneficiary = await adminFindBeneficiaryByTokenHash(hashTokenSha256(rawToken));
  if (!beneficiary) return { status: "invalid_token" };

  const { deadMansSwitch } = beneficiary;
  if (deadMansSwitch.status !== "TRIGGERED") {
    if (deadMansSwitch.status === "RECOVERED") return { status: "already_recovered" };
    return { status: "not_triggered", switchStatus: deadMansSwitch.status };
  }

  let share: ReturnType<typeof decodeShare>;
  try {
    share = decodeShare(encodedShare);
  } catch {
    return { status: "invalid_share_format" };
  }

  if (share.index !== beneficiary.shareIndex || hashShareValueSha256(share.value) !== beneficiary.shareHash) {
    return { status: "share_hash_mismatch" };
  }

  await adminUpsertShareSubmission({
    userId: beneficiary.userId,
    deadMansSwitchId: deadMansSwitch.id,
    beneficiaryId: beneficiary.id,
    shareValueCiphertext: encryptField(encodedShare),
  });

  const fresh = await adminGetSwitchWithSubmissions(deadMansSwitch.id);
  /* c8 ignore next -- unreachable: the row was just read/written above under the same id */
  if (!fresh) return { status: "invalid_token" };

  if (fresh.shareSubmissions.length < fresh.thresholdShares) {
    return { status: "accepted_pending", submittedCount: fresh.shareSubmissions.length, thresholdShares: fresh.thresholdShares };
  }

  // Threshold crossed — attempt reconstruction now, in this same request.
  const shares = fresh.shareSubmissions.map((submission) => {
    const decodedShare = decodeShare(decryptField(submission.shareValueCiphertext));
    return decodedShare;
  });

  const reconstructedKey = combineShares(shares);

  let canaryOk: boolean;
  try {
    // "pfw-dead-mans-switch-vault-canary-v1" deliberately duplicates
    // src/lib/dead-mans-switch-crypto.ts's DMS_CANARY_PLAINTEXT rather
    // than importing it — importing that module here would trip
    // tests/guards/dead-mans-switch-crypto-client-only.test.ts, the same
    // "duplicate the constant, never the client-only module" trade-off
    // src/server/api/zk-validation.ts already makes for zk-crypto.ts's
    // PBKDF2 iteration floor (§3m).
    canaryOk = decryptVaultValueNode(reconstructedKey, fresh.vaultCanaryCiphertext) === "pfw-dead-mans-switch-vault-canary-v1";
  } catch {
    canaryOk = false;
  }

  if (!canaryOk) {
    // Should not happen given every stored share already passed its own
    // shareHash check above (see this file's doc comment) — kept as a
    // defense-in-depth backstop, same belt-and-suspenders philosophy as
    // everywhere else in this app's crypto. Explicitly does NOT mark the
    // switch RECOVERED and does NOT expose any document content.
    return { status: "key_verification_failed" };
  }

  const documents = fresh.documents.map((document) => ({
    id: document.id,
    title: document.title,
    plaintext: decryptVaultValueNode(reconstructedKey, document.ciphertext),
  }));

  await adminMarkRecovered(deadMansSwitch.id);

  return { status: "recovered", documents };
}
