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
