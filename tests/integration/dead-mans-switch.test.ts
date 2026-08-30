import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DMS_CANARY_PLAINTEXT,
  DMS_PBKDF2_ITERATIONS,
  deriveVaultKeyBytes,
  encryptVaultValue,
  generateVaultSalt,
  importVaultAesKey,
} from "../../src/lib/dead-mans-switch-crypto";
import { encodeShare, splitSecret, type Share } from "../../src/lib/shamir-secret-sharing";
import { createAdminClient } from "../../src/server/db/admin-client";
import { cancelRecovery, getVaultStatus, setupVault } from "../../src/server/dal/dead-mans-switch";
import { runInactivityCheck } from "../../src/server/dead-mans-switch/inactivity-check";
import { getRecoveryPortalStatus, submitRecoveryShare } from "../../src/server/dead-mans-switch/recovery-service";

/**
 * Integration coverage for the Cryptographic Dead Man's Switch
 * (AGENTS.md §3t): the vault stays completely sealed while
 * ACTIVE/GRACE_PERIOD, the Activity Monitor's batch transitions work
 * correctly, and recovery only succeeds once >= thresholdShares distinct,
 * hash-verified shares are submitted while TRIGGERED — never before, and
 * never from an insufficient or wrong set. Skipped without a live DB,
 * same convention as every other integration test.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("Cryptographic Dead Man's Switch", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let owner: { id: string };

  beforeAll(async () => {
    admin = createAdminClient();
    owner = await admin.user.create({
      data: { email: `dms-test-owner-${Date.now()}@pfw.local`, displayName: "DMS Test Owner" },
    });
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { id: owner.id } });
    await admin.$disconnect();
  });

  /** Builds a real, fully client-crypto-generated setup payload — the same shape src/app/vault/_components/vault-setup-wizard.tsx sends. */
  async function buildRealVaultSetup(passphrase: string, beneficiaryLabels: string[], threshold: number, documentContents: { title: string; content: string }[]) {
    const salt = generateVaultSalt();
    const rawKey = await deriveVaultKeyBytes(passphrase, salt, DMS_PBKDF2_ITERATIONS);
    const key = await importVaultAesKey(rawKey);
    const canaryCiphertext = await encryptVaultValue(key, DMS_CANARY_PLAINTEXT);

    const documents = await Promise.all(
      documentContents.map(async (d) => ({ title: d.title, ciphertext: await encryptVaultValue(key, d.content) })),
    );

    const shares = splitSecret(rawKey, beneficiaryLabels.length, threshold);

    async function sha256Hex(bytes: Uint8Array): Promise<string> {
      const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
      return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    }

    const beneficiaryDrafts = await Promise.all(
      shares.map(async (share: Share, i) => {
        const rawToken = `test-token-${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`;
        const inviteTokenHash = await sha256Hex(new TextEncoder().encode(rawToken));
        const shareHash = await sha256Hex(share.value);
        return { label: beneficiaryLabels[i], shareIndex: share.index, shareHash, inviteTokenHash, rawToken, encodedShare: encodeShare(share) };
      }),
    );

    return {
      setupInput: {
        salt,
        iterations: DMS_PBKDF2_ITERATIONS,
        canaryCiphertext,
        totalShares: beneficiaryLabels.length,
        thresholdShares: threshold,
        inactivityThresholdDays: 90,
        gracePeriodDays: 14,
        beneficiaries: beneficiaryDrafts.map((b) => ({ label: b.label, shareIndex: b.shareIndex, shareHash: b.shareHash, inviteTokenHash: b.inviteTokenHash })),
        documents,
      },
      beneficiaryDrafts,
    };
  }

  it("reports not-set-up before any setup call", async () => {
    await expect(getVaultStatus(owner.id)).resolves.toMatchObject({ isSetUp: false, status: null });
  });

  it("full lifecycle: sealed while ACTIVE, refuses recovery, triggers, stays sealed under threshold, and decrypts correctly once threshold is met", async () => {
    const { setupInput, beneficiaryDrafts } = await buildRealVaultSetup(
      "a genuinely long emergency recovery passphrase",
      ["Spouse", "Sibling", "Best Friend"],
      2,
      [{ title: "Will location", content: "Filed with attorney at 12 Herzl St." }],
    );

    const setupResult = await setupVault(owner.id, setupInput);
    expect(setupResult).toEqual({ ok: true });

    // A second setup call is refused outright (no re-split flow).
    await expect(setupVault(owner.id, setupInput)).resolves.toEqual({ ok: false, error: "already_set_up" });

    const statusAfterSetup = await getVaultStatus(owner.id);
    expect(statusAfterSetup.isSetUp).toBe(true);
    expect(statusAfterSetup.status).toBe("ACTIVE");
    expect(statusAfterSetup.beneficiaries).toHaveLength(3);
    expect(statusAfterSetup.documents).toHaveLength(1);

    const [beneficiaryA, beneficiaryB, beneficiaryC] = beneficiaryDrafts;

    // The vault is completely sealed while ACTIVE: a correct share is
    // rejected outright, not just "not enough yet".
    const sealedAttempt = await submitRecoveryShare(beneficiaryA.rawToken, beneficiaryA.encodedShare);
    expect(sealedAttempt).toEqual({ status: "not_triggered", switchStatus: "ACTIVE" });

    // Simulate the Activity Monitor having triggered this switch (the
    // batch check itself is exercised separately below).
    const vaultRow = await admin.deadMansSwitch.findUniqueOrThrow({ where: { userId: owner.id } });
    await admin.deadMansSwitch.update({ where: { id: vaultRow.id }, data: { status: "TRIGGERED", triggeredAt: new Date() } });

    // An invalid token is rejected without revealing anything.
    await expect(submitRecoveryShare("not-a-real-token", beneficiaryA.encodedShare)).resolves.toEqual({ status: "invalid_token" });

    // A validly-formed share that just doesn't belong to THIS invite
    // token (beneficiary B's real share, submitted under A's token) is
    // rejected — and does NOT get counted or corrupt anything.
    await expect(submitRecoveryShare(beneficiaryA.rawToken, beneficiaryB.encodedShare)).resolves.toEqual({ status: "share_hash_mismatch" });

    // A corrupted/malformed share string (fails decodeShare's own
    // checksum, never even reaches the hash comparison) is rejected too.
    // Flips a character mid-value-segment — not the last character,
    // which can land on a base64 padding bit that doesn't actually
    // change the decoded bytes (see shamir-secret-sharing.test.ts's
    // matching fix for the same trap).
    const shareParts = beneficiaryA.encodedShare.split(":");
    const middle = Math.floor(shareParts[2].length / 2);
    shareParts[2] = shareParts[2].slice(0, middle) + (shareParts[2][middle] === "A" ? "B" : "A") + shareParts[2].slice(middle + 1);
    await expect(submitRecoveryShare(beneficiaryA.rawToken, shareParts.join(":"))).resolves.toEqual({ status: "invalid_share_format" });

    const statusBeforeAnySubmission = await getRecoveryPortalStatus(beneficiaryA.rawToken);
    expect(statusBeforeAnySubmission).toMatchObject({ found: true, switchStatus: "TRIGGERED", submittedShareCount: 0, hasSubmitted: false });

    // First correct share: below threshold (2), vault stays sealed.
    const firstSubmission = await submitRecoveryShare(beneficiaryA.rawToken, beneficiaryA.encodedShare);
    expect(firstSubmission).toEqual({ status: "accepted_pending", submittedCount: 1, thresholdShares: 2 });

    const statusOwnerSide = await getVaultStatus(owner.id);
    expect(statusOwnerSide.status).toBe("TRIGGERED");
    expect(statusOwnerSide.submittedShareCount).toBe(1);

    // A third beneficiary sees the count without seeing WHO submitted.
    const statusForC = await getRecoveryPortalStatus(beneficiaryC.rawToken);
    expect(statusForC).toMatchObject({ found: true, submittedShareCount: 1, hasSubmitted: false });

    // Second correct share crosses the threshold — reconstruction happens
    // now, and the real document plaintext comes back correctly.
    const secondSubmission = await submitRecoveryShare(beneficiaryB.rawToken, beneficiaryB.encodedShare);
    expect(secondSubmission.status).toBe("recovered");
    if (secondSubmission.status === "recovered") {
      expect(secondSubmission.documents).toEqual([
        { id: statusAfterSetup.documents[0].id, title: "Will location", plaintext: "Filed with attorney at 12 Herzl St." },
      ]);
    }

    const statusAfterRecovery = await getVaultStatus(owner.id);
    expect(statusAfterRecovery.status).toBe("RECOVERED");

    // A late, uninvolved beneficiary submitting afterward gets a clear
    // "already recovered", never document content of their own.
    await expect(submitRecoveryShare(beneficiaryC.rawToken, beneficiaryC.encodedShare)).resolves.toEqual({ status: "already_recovered" });
  });

  it("an insufficient set of correctly-hash-verified shares never decrypts anything (threshold is enforced, not just hash validity)", async () => {
    const { setupInput, beneficiaryDrafts } = await buildRealVaultSetup(
      "another long emergency recovery passphrase here",
      ["A", "B", "C", "D"],
      3,
      [{ title: "Secret", content: "should never leak below threshold" }],
    );
    const owner2 = await admin.user.create({ data: { email: `dms-test-owner2-${Date.now()}@pfw.local`, displayName: "DMS Test Owner 2" } });

    try {
      await setupVault(owner2.id, setupInput);
      const vaultRow = await admin.deadMansSwitch.findUniqueOrThrow({ where: { userId: owner2.id } });
      await admin.deadMansSwitch.update({ where: { id: vaultRow.id }, data: { status: "TRIGGERED", triggeredAt: new Date() } });

      const [a, b] = beneficiaryDrafts; // only 2 of 4, threshold is 3
      await submitRecoveryShare(a.rawToken, a.encodedShare);
      const result = await submitRecoveryShare(b.rawToken, b.encodedShare);

      expect(result).toEqual({ status: "accepted_pending", submittedCount: 2, thresholdShares: 3 });

      const finalStatus = await getVaultStatus(owner2.id);
      expect(finalStatus.status).toBe("TRIGGERED"); // still sealed
    } finally {
      await admin.user.deleteMany({ where: { id: owner2.id } });
    }
  });

  it("cancelRecovery reverts TRIGGERED -> ACTIVE and clears prior share submissions, so a future trigger starts clean", async () => {
    const { setupInput, beneficiaryDrafts } = await buildRealVaultSetup("a third long emergency recovery passphrase", ["X", "Y"], 2, []);
    const owner3 = await admin.user.create({ data: { email: `dms-test-owner3-${Date.now()}@pfw.local`, displayName: "DMS Test Owner 3" } });

    try {
      await setupVault(owner3.id, setupInput);
      const vaultRow = await admin.deadMansSwitch.findUniqueOrThrow({ where: { userId: owner3.id } });
      await admin.deadMansSwitch.update({ where: { id: vaultRow.id }, data: { status: "TRIGGERED", triggeredAt: new Date() } });

      const [x] = beneficiaryDrafts;
      await submitRecoveryShare(x.rawToken, x.encodedShare);
      expect((await getVaultStatus(owner3.id)).submittedShareCount).toBe(1);

      await expect(cancelRecovery(owner3.id)).resolves.toEqual({ ok: true });

      const afterCancel = await getVaultStatus(owner3.id);
      expect(afterCancel.status).toBe("ACTIVE");
      expect(afterCancel.submittedShareCount).toBe(0);

      // cancelRecovery on an already-ACTIVE switch is rejected.
      await expect(cancelRecovery(owner3.id)).resolves.toEqual({ ok: false, error: "not_triggered" });

      // Re-trigger and confirm the old submission really doesn't silently count.
      await admin.deadMansSwitch.update({ where: { id: vaultRow.id }, data: { status: "TRIGGERED", triggeredAt: new Date() } });
      const statusForX = await getRecoveryPortalStatus(x.rawToken);
      expect(statusForX).toMatchObject({ submittedShareCount: 0, hasSubmitted: false });
    } finally {
      await admin.user.deleteMany({ where: { id: owner3.id } });
    }
  });

  it("runInactivityCheck advances ACTIVE -> GRACE_PERIOD -> TRIGGERED as thresholds elapse, and leaves an active switch alone otherwise", async () => {
    const { setupInput } = await buildRealVaultSetup("a fourth long emergency recovery passphrase", ["P", "Q"], 2, []);
    const owner4 = await admin.user.create({ data: { email: `dms-test-owner4-${Date.now()}@pfw.local`, displayName: "DMS Test Owner 4" } });

    try {
      const setup = { ...setupInput, inactivityThresholdDays: 90, gracePeriodDays: 14 };
      await setupVault(owner4.id, setup);
      const vaultRow = await admin.deadMansSwitch.findUniqueOrThrow({ where: { userId: owner4.id } });

      // Fresh setup: nowhere near the inactivity threshold yet.
      const noopResult = await runInactivityCheck();
      expect(noopResult.movedToGracePeriod).not.toContain(vaultRow.id);

      // Backdate lastActivityAt past the 90-day threshold.
      await admin.deadMansSwitch.update({
        where: { id: vaultRow.id },
        data: { lastActivityAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000) },
      });
      const graceResult = await runInactivityCheck();
      expect(graceResult.movedToGracePeriod).toContain(vaultRow.id);

      const afterGrace = await admin.deadMansSwitch.findUniqueOrThrow({ where: { id: vaultRow.id } });
      expect(afterGrace.status).toBe("GRACE_PERIOD");
      expect(afterGrace.graceStartedAt).not.toBeNull();

      // Not yet past the 14-day grace period.
      const stillGraceResult = await runInactivityCheck();
      expect(stillGraceResult.triggered).not.toContain(vaultRow.id);

      // Backdate graceStartedAt past the 14-day grace period.
      await admin.deadMansSwitch.update({
        where: { id: vaultRow.id },
        data: { graceStartedAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000) },
      });
      const triggerResult = await runInactivityCheck();
      expect(triggerResult.triggered).toContain(vaultRow.id);

      const afterTrigger = await admin.deadMansSwitch.findUniqueOrThrow({ where: { id: vaultRow.id } });
      expect(afterTrigger.status).toBe("TRIGGERED");
      expect(afterTrigger.triggeredAt).not.toBeNull();
    } finally {
      await admin.user.deleteMany({ where: { id: owner4.id } });
    }
  });

  it("does not leak one user's vault status/beneficiaries into another user's status (IDOR)", async () => {
    const owner5 = await admin.user.create({ data: { email: `dms-test-owner5-${Date.now()}@pfw.local`, displayName: "DMS Test Owner 5" } });
    try {
      await expect(getVaultStatus(owner5.id)).resolves.toMatchObject({ isSetUp: false });
      // owner (from the lifecycle test above) has a real vault; owner5 must never see it.
      const owner5Status = await getVaultStatus(owner5.id);
      expect(owner5Status.beneficiaries).toEqual([]);
      expect(owner5Status.documents).toEqual([]);
    } finally {
      await admin.user.deleteMany({ where: { id: owner5.id } });
    }
  });
});
