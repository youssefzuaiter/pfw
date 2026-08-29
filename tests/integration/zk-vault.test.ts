import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encryptField } from "../../src/server/crypto/field-encryption";
import { createAdminClient } from "../../src/server/db/admin-client";
import { updateGoalContributionNote } from "../../src/server/dal/goals";
import { findLegacyNoteContributions, getZkVaultStatus, setupZkVault } from "../../src/server/dal/zk-vault";

/**
 * Integration coverage for the zero-knowledge note vault (AGENTS.md §3m):
 * setup is genuinely one-time, legacy ("v1:...") notes are decrypted
 * correctly for migration while already-migrated ("zk1:...") ones are
 * left alone, and note updates are IDOR-safe — same conventions as
 * tests/integration/idor.test.ts. Skipped without a live DB, same as
 * every other integration test.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("zero-knowledge vault DAL", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let userA: { id: string };
  let userB: { id: string };
  let goalA: { id: string };

  beforeAll(async () => {
    admin = createAdminClient();
    userA = await admin.user.create({
      data: { email: `zk-test-a-${Date.now()}@pfw.local`, displayName: "ZK Test A" },
    });
    userB = await admin.user.create({
      data: { email: `zk-test-b-${Date.now()}@pfw.local`, displayName: "ZK Test B" },
    });
    goalA = await admin.goal.create({
      data: { userId: userA.id, name: "Test goal", targetAmount: 100_000n },
    });
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
    await admin.$disconnect();
  });

  it("reports not-set-up before any setup call", async () => {
    await expect(getZkVaultStatus(userA.id)).resolves.toMatchObject({ isSetUp: false, salt: null });
  });

  it("sets up the vault and then reports the stored (non-secret) parameters back", async () => {
    const result = await setupZkVault(userA.id, {
      salt: "dGVzdC1zYWx0",
      iterations: 600_000,
      canaryCiphertext: "zk1:aWQ=:aWQ=",
    });
    expect(result).toEqual({ ok: true });

    await expect(getZkVaultStatus(userA.id)).resolves.toEqual({
      isSetUp: true,
      salt: "dGVzdC1zYWx0",
      iterations: 600_000,
      canaryCiphertext: "zk1:aWQ=:aWQ=",
    });
  });

  it("refuses a second setup call rather than overwriting the existing vault", async () => {
    const result = await setupZkVault(userA.id, {
      salt: "a-different-salt",
      iterations: 600_000,
      canaryCiphertext: "zk1:YWE=:YWE=",
    });
    expect(result).toEqual({ ok: false, error: "already_set_up" });

    // Confirms the refusal actually left the original values untouched.
    await expect(getZkVaultStatus(userA.id)).resolves.toMatchObject({ salt: "dGVzdC1zYWx0" });
  });

  it("does not leak one user's vault setup into another user's status", async () => {
    await expect(getZkVaultStatus(userB.id)).resolves.toMatchObject({ isSetUp: false, salt: null });
  });

  it("finds and decrypts a legacy (pre-vault) note, and leaves an already-migrated one alone", async () => {
    const legacy = await admin.goalContribution.create({
      data: {
        userId: userA.id,
        goalId: goalA.id,
        amount: 5_000n,
        contributedAt: new Date(),
        note: encryptField("a legacy plaintext note"),
      },
    });
    const alreadyMigrated = await admin.goalContribution.create({
      data: {
        userId: userA.id,
        goalId: goalA.id,
        amount: 1_000n,
        contributedAt: new Date(),
        note: "zk1:abcd:efgh",
      },
    });
    const withoutNote = await admin.goalContribution.create({
      data: { userId: userA.id, goalId: goalA.id, amount: 2_000n, contributedAt: new Date() },
    });

    const legacyNotes = await findLegacyNoteContributions(userA.id);

    expect(legacyNotes).toEqual([{ id: legacy.id, goalId: goalA.id, plaintext: "a legacy plaintext note" }]);
    expect(legacyNotes.map((n) => n.id)).not.toContain(alreadyMigrated.id);
    expect(legacyNotes.map((n) => n.id)).not.toContain(withoutNote.id);
  });

  it("updateGoalContributionNote overwrites the note with new ciphertext", async () => {
    const contribution = await admin.goalContribution.create({
      data: { userId: userA.id, goalId: goalA.id, amount: 3_000n, contributedAt: new Date() },
    });

    const updated = await updateGoalContributionNote(userA.id, contribution.id, "zk1:newiv:newciphertext");
    expect(updated).toMatchObject({ note: "zk1:newiv:newciphertext" });
  });

  it("User B cannot overwrite User A's contribution note (IDOR)", async () => {
    const contribution = await admin.goalContribution.create({
      data: { userId: userA.id, goalId: goalA.id, amount: 4_000n, contributedAt: new Date() },
    });

    await expect(updateGoalContributionNote(userB.id, contribution.id, "zk1:hijack:hijack")).resolves.toBeNull();

    // Confirms the attempt genuinely didn't change anything.
    const untouched = await admin.goalContribution.findUnique({ where: { id: contribution.id } });
    expect(untouched?.note).toBeNull();
  });
});
