import "server-only";
import { withUserScope } from "../db/with-user-scope";

/**
 * Owner-side DAL for the Cryptographic Dead Man's Switch (AGENTS.md §3t).
 * Every function here is called by the authenticated vault owner and goes
 * through the normal RLS-scoped `withUserScope` path — nothing in this
 * file ever sees a passphrase, a raw share, or decrypted document
 * content (the server-side codec — src/server/crypto/field-encryption.ts —
 * covers `RecoveryShareSubmission.shareValueCiphertext` only, and even
 * that is never decrypted here; see recovery-service.ts). The anonymous
 * beneficiary/token flow lives entirely in a separate file,
 * src/server/dead-mans-switch/recovery-admin-ops.ts, the same split
 * src/server/dal/shared-groups.ts and invite-admin-ops.ts already
 * established (§3s).
 */

export type VaultBeneficiaryView = { id: string; label: string; shareIndex: number; createdAt: Date };
export type VaultDocumentView = { id: string; title: string; ciphertext: string; createdAt: Date; updatedAt: Date };

export type VaultStatus = {
  isSetUp: boolean;
  status: "ACTIVE" | "GRACE_PERIOD" | "TRIGGERED" | "RECOVERED" | null;
  inactivityThresholdDays: number | null;
  gracePeriodDays: number | null;
  lastActivityAt: Date | null;
  graceStartedAt: Date | null;
  triggeredAt: Date | null;
  recoveredAt: Date | null;
  totalShares: number | null;
  thresholdShares: number | null;
  salt: string | null;
  iterations: number | null;
  canaryCiphertext: string | null;
  beneficiaries: VaultBeneficiaryView[];
  documents: VaultDocumentView[];
  /** How many distinct beneficiaries have submitted a share for the CURRENT trigger — only meaningful while status = TRIGGERED (recovery-admin-ops.ts clears stale submissions on every fresh trigger/cancel, see inactivity-check.ts and cancelRecovery). */
  submittedShareCount: number;
};

export async function getVaultStatus(userId: string): Promise<VaultStatus> {
  const vault = await withUserScope(userId, (tx) =>
    tx.deadMansSwitch.findUnique({
      where: { userId },
      include: {
        beneficiaries: { orderBy: { shareIndex: "asc" } },
        documents: { orderBy: { createdAt: "asc" } },
        shareSubmissions: true,
      },
    }),
  );

  if (!vault) {
    return {
      isSetUp: false,
      status: null,
      inactivityThresholdDays: null,
      gracePeriodDays: null,
      lastActivityAt: null,
      graceStartedAt: null,
      triggeredAt: null,
      recoveredAt: null,
      totalShares: null,
      thresholdShares: null,
      salt: null,
      iterations: null,
      canaryCiphertext: null,
      beneficiaries: [],
      documents: [],
      submittedShareCount: 0,
    };
  }

  return {
    isSetUp: true,
    status: vault.status,
    inactivityThresholdDays: vault.inactivityThresholdDays,
    gracePeriodDays: vault.gracePeriodDays,
    lastActivityAt: vault.lastActivityAt,
    graceStartedAt: vault.graceStartedAt,
    triggeredAt: vault.triggeredAt,
    recoveredAt: vault.recoveredAt,
    totalShares: vault.totalShares,
    thresholdShares: vault.thresholdShares,
    salt: vault.vaultSalt,
    iterations: vault.vaultKdfIterations,
    canaryCiphertext: vault.vaultCanaryCiphertext,
    beneficiaries: vault.beneficiaries.map((b) => ({
      id: b.id,
      label: b.label,
      shareIndex: b.shareIndex,
      createdAt: b.createdAt,
    })),
    documents: vault.documents.map((d) => ({
      id: d.id,
      title: d.title,
      ciphertext: d.ciphertext,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    })),
    submittedShareCount: vault.shareSubmissions.length,
  };
}

export type SetupVaultInput = {
  salt: string;
  iterations: number;
  canaryCiphertext: string;
  totalShares: number;
  thresholdShares: number;
  inactivityThresholdDays: number;
  gracePeriodDays: number;
  /** Each beneficiary's slot: the SSS share index it corresponds to, a hash of the raw share value (never the value itself), and the SHA-256 hash of the invite token (the raw token was already shown to the caller once, client-side, and is never sent here). */
  beneficiaries: { label: string; shareIndex: number; shareHash: string; inviteTokenHash: string }[];
  documents: { title: string; ciphertext: string }[];
};

export type SetupVaultResult = { ok: true } | { ok: false; error: "already_set_up" | "beneficiary_count_mismatch" };

/**
 * One-time only, like `setupZkVault` — the share indices/hashes and the
 * salt/iterations are all tied to one specific polynomial split
 * (src/lib/shamir-secret-sharing.ts) generated once, client-side, at
 * setup. There is deliberately no "add a beneficiary later" or "rotate
 * the passphrase" flow: either would require re-splitting the secret and
 * redistributing every share from scratch, which is a bigger operation
 * than this pass builds — see AGENTS.md §3t's known-limitations note.
 */
export async function setupVault(userId: string, input: SetupVaultInput): Promise<SetupVaultResult> {
  if (input.beneficiaries.length !== input.totalShares) {
    return { ok: false, error: "beneficiary_count_mismatch" };
  }

  return withUserScope(userId, async (tx) => {
    const existing = await tx.deadMansSwitch.findUnique({ where: { userId } });
    if (existing) return { ok: false, error: "already_set_up" };

    await tx.deadMansSwitch.create({
      data: {
        userId,
        status: "ACTIVE",
        inactivityThresholdDays: input.inactivityThresholdDays,
        gracePeriodDays: input.gracePeriodDays,
        totalShares: input.totalShares,
        thresholdShares: input.thresholdShares,
        vaultSalt: input.salt,
        vaultKdfIterations: input.iterations,
        vaultCanaryCiphertext: input.canaryCiphertext,
        beneficiaries: {
          create: input.beneficiaries.map((b) => ({
            userId,
            label: b.label,
            shareIndex: b.shareIndex,
            shareHash: b.shareHash,
            inviteTokenHash: b.inviteTokenHash,
          })),
        },
        documents: {
          create: input.documents.map((d) => ({ userId, title: d.title, ciphertext: d.ciphertext })),
        },
      },
    });

    return { ok: true };
  });
}

export type AddDocumentResult = { ok: true; id: string } | { ok: false; error: "not_set_up" };

export async function addDocument(userId: string, title: string, ciphertext: string): Promise<AddDocumentResult> {
  return withUserScope(userId, async (tx) => {
    const vault = await tx.deadMansSwitch.findUnique({ where: { userId } });
    if (!vault) return { ok: false, error: "not_set_up" };

    const document = await tx.emergencyDocument.create({
      data: { userId, deadMansSwitchId: vault.id, title, ciphertext },
    });
    return { ok: true, id: document.id };
  });
}

export type DeleteDocumentResult = { ok: true } | { ok: false; error: "not_found" };

export async function deleteDocument(userId: string, documentId: string): Promise<DeleteDocumentResult> {
  return withUserScope(userId, async (tx) => {
    const document = await tx.emergencyDocument.findFirst({ where: { id: documentId, userId } });
    if (!document) return { ok: false, error: "not_found" };

    await tx.emergencyDocument.delete({ where: { id: documentId } });
    return { ok: true };
  });
}

export type RotateVaultPassphraseInput = {
  newSalt: string;
  newIterations: number;
  newCanaryCiphertext: string;
  documents: { id: string; ciphertext: string }[];
  /** Every beneficiary's NEW share for the (unchanged) total/threshold configuration — a rotation always re-splits the new key, since a fresh key needs a fresh polynomial regardless of the share count. Keyed by the EXISTING `Beneficiary.id` (labels/tokens are untouched — only the cryptographic material changes). */
  beneficiaries: { id: string; shareIndex: number; shareHash: string }[];
};

export type RotateVaultPassphraseResult =
  | { ok: true }
  | { ok: false; error: "not_set_up" | "not_active" | "document_set_mismatch" | "beneficiary_set_mismatch" };

/**
 * Passphrase Rotation, Emergency Vault half (AGENTS.md §3t amendment,
 * item 1). Atomically overwrites the vault's
 * salt/iterations/canary/totalShares-count-derived state, every
 * `EmergencyDocument.ciphertext`, and every `Beneficiary`'s
 * shareIndex/shareHash — one real Postgres transaction (`withUserScope`)
 * — plus clears any `RecoveryShareSubmission` rows, since a submission
 * encodes a share under the OLD polynomial and would silently combine
 * into garbage against the new one otherwise (the same defensive clear
 * `cancelRecovery` already does on its own state transition).
 *
 * Only allowed while `status === "ACTIVE"` — rotating shares out from
 * under an in-progress recovery (GRACE_PERIOD/TRIGGERED) would be
 * actively dangerous (a beneficiary mid-submission holds a share for a
 * polynomial that's about to stop existing) and confusing regardless;
 * the owner should `cancelRecovery` first if one is somehow open.
 *
 * Re-verifies the CURRENT document-id set and beneficiary-id set inside
 * the transaction against what the caller submitted — same
 * "notes_changed_concurrently"-style fail-closed check
 * `rotateZkVaultPassphrase` makes for goal notes, applied to two
 * collections here instead of one, since a rotation must cover every
 * document AND every beneficiary or none at all (a partial rotation
 * would leave some documents undecryptable under the new key, or some
 * beneficiaries holding shares of a secret they can no longer verify).
 */
export async function rotateVaultPassphrase(
  userId: string,
  input: RotateVaultPassphraseInput,
): Promise<RotateVaultPassphraseResult> {
  return withUserScope(userId, async (tx) => {
    const vault = await tx.deadMansSwitch.findUnique({
      where: { userId },
      include: { documents: true, beneficiaries: true },
    });
    if (!vault) return { ok: false, error: "not_set_up" };
    if (vault.status !== "ACTIVE") return { ok: false, error: "not_active" };

    const currentDocumentIds = new Set(vault.documents.map((d) => d.id));
    const submittedDocumentIds = new Set(input.documents.map((d) => d.id));
    const documentsMatch =
      currentDocumentIds.size === submittedDocumentIds.size &&
      [...currentDocumentIds].every((id) => submittedDocumentIds.has(id));
    if (!documentsMatch) return { ok: false, error: "document_set_mismatch" };

    const currentBeneficiaryIds = new Set(vault.beneficiaries.map((b) => b.id));
    const submittedBeneficiaryIds = new Set(input.beneficiaries.map((b) => b.id));
    const beneficiariesMatch =
      currentBeneficiaryIds.size === submittedBeneficiaryIds.size &&
      [...currentBeneficiaryIds].every((id) => submittedBeneficiaryIds.has(id));
    if (!beneficiariesMatch) return { ok: false, error: "beneficiary_set_mismatch" };

    await tx.deadMansSwitch.update({
      where: { id: vault.id },
      data: { vaultSalt: input.newSalt, vaultKdfIterations: input.newIterations, vaultCanaryCiphertext: input.newCanaryCiphertext },
    });

    for (const document of input.documents) {
      await tx.emergencyDocument.update({ where: { id: document.id }, data: { ciphertext: document.ciphertext } });
    }

    for (const beneficiary of input.beneficiaries) {
      await tx.beneficiary.update({
        where: { id: beneficiary.id },
        data: { shareIndex: beneficiary.shareIndex, shareHash: beneficiary.shareHash },
      });
    }

    // Any in-flight submission encodes a share of the polynomial that
    // just stopped existing — see this function's own doc comment.
    await tx.recoveryShareSubmission.deleteMany({ where: { deadMansSwitchId: vault.id } });

    return { ok: true };
  });
}

export type UpdateVaultBeneficiary = { label: string; shareIndex: number; shareHash: string; inviteTokenHash: string };

export type UpdateVaultBeneficiariesInput = {
  totalShares: number;
  thresholdShares: number;
  /**
   * The complete NEW beneficiary roster, for EVERY beneficiary —
   * continuing or newly added. There is no "update in place, preserving
   * the id" path: re-splitting the same master key under a new total/
   * threshold configuration produces an entirely new polynomial (see
   * `resplit`'s worker-side doc comment,
   * `src/lib/workers/dead-mans-switch-crypto-worker-handlers.ts`), which
   * means every beneficiary's share value AND recovery link go stale at
   * once, including a beneficiary whose slot was otherwise unchanged —
   * `vault-setup-wizard.tsx`'s own setup flow already generates a fresh
   * `inviteTokenHash` client-side per beneficiary for exactly this
   * reason, and this function asks the same of every caller here, not
   * just the genuinely-new entries.
   */
  beneficiaries: UpdateVaultBeneficiary[];
};

export type UpdateVaultBeneficiariesResult =
  | { ok: true }
  | { ok: false; error: "not_set_up" | "not_active" | "beneficiary_count_mismatch" };

/**
 * Dynamic Beneficiaries (AGENTS.md §3t amendment, item 2). Deletes every
 * EXISTING `Beneficiary` row for this vault and creates the entire new
 * roster fresh, inside one transaction — deliberately delete-then-insert
 * rather than a sequence of per-row updates: `@@unique([deadMansSwitchId,
 * shareIndex])` is a plain Postgres unique INDEX (not a DEFERRABLE
 * constraint), so reassigning share indices among EXISTING rows one
 * statement at a time can transiently collide mid-transaction whenever
 * two rows' old/new indices cross (e.g. row A's new index 5 momentarily
 * equals row B's still-old index 5) — delete-then-insert-into-an-empty-set
 * has no such transient state to collide in. `Beneficiary.id` is
 * therefore NOT stable across this operation for any beneficiary,
 * continuing or new — see `UpdateVaultBeneficiariesInput`'s own doc
 * comment for why that's also the cryptographically correct behavior,
 * not just an implementation convenience.
 *
 * Documents are NOT touched: the master key itself is unchanged by a
 * resplit, only how it's divided among beneficiaries. Only allowed while
 * `status === "ACTIVE"`, same reasoning as `rotateVaultPassphrase`.
 * Clears any `RecoveryShareSubmission` rows for the same reason too
 * (each references a `beneficiaryId` that's about to stop existing
 * regardless, so `onDelete: Cascade` on that FK would clear them anyway —
 * this is done explicitly first for clarity, not relied on implicitly).
 */
export async function updateVaultBeneficiaries(
  userId: string,
  input: UpdateVaultBeneficiariesInput,
): Promise<UpdateVaultBeneficiariesResult> {
  if (input.beneficiaries.length !== input.totalShares) {
    return { ok: false, error: "beneficiary_count_mismatch" };
  }

  return withUserScope(userId, async (tx) => {
    const vault = await tx.deadMansSwitch.findUnique({ where: { userId } });
    if (!vault) return { ok: false, error: "not_set_up" };
    if (vault.status !== "ACTIVE") return { ok: false, error: "not_active" };

    await tx.recoveryShareSubmission.deleteMany({ where: { deadMansSwitchId: vault.id } });
    await tx.beneficiary.deleteMany({ where: { deadMansSwitchId: vault.id } });

    await tx.deadMansSwitch.update({
      where: { id: vault.id },
      data: { totalShares: input.totalShares, thresholdShares: input.thresholdShares },
    });

    await tx.beneficiary.createMany({
      data: input.beneficiaries.map((beneficiary) => ({
        userId,
        deadMansSwitchId: vault.id,
        label: beneficiary.label,
        shareIndex: beneficiary.shareIndex,
        shareHash: beneficiary.shareHash,
        inviteTokenHash: beneficiary.inviteTokenHash,
      })),
    });

    return { ok: true };
  });
}

export type CancelRecoveryResult = { ok: true } | { ok: false; error: "not_set_up" | "not_triggered" };

/**
 * The vault owner's explicit "I'm alive, stop recovery" action — the
 * only way a TRIGGERED switch reverts to ACTIVE (see DeadMansSwitch's
 * model comment for why mere activity/login does NOT auto-cancel a
 * triggered recovery). Deliberately clears every
 * `RecoveryShareSubmission` for this vault: those submissions were only
 * ever meaningful for the recovery attempt that's being cancelled here —
 * a future trigger should start from zero submitted shares, not
 * silently count old ones toward a fresh attempt.
 */
export async function cancelRecovery(userId: string): Promise<CancelRecoveryResult> {
  return withUserScope(userId, async (tx) => {
    const vault = await tx.deadMansSwitch.findUnique({ where: { userId } });
    if (!vault) return { ok: false, error: "not_set_up" };
    if (vault.status !== "TRIGGERED") return { ok: false, error: "not_triggered" };

    await tx.recoveryShareSubmission.deleteMany({ where: { deadMansSwitchId: vault.id } });
    await tx.deadMansSwitch.update({
      where: { id: vault.id },
      data: { status: "ACTIVE", graceStartedAt: null, triggeredAt: null, lastActivityAt: new Date() },
    });
    return { ok: true };
  });
}
