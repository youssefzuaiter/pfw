import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encryptField } from "../../src/server/crypto/field-encryption";
import { createAdminClient } from "../../src/server/db/admin-client";
import { updateGoalContributionNote } from "../../src/server/dal/goals";
import {
  findLegacyNoteContributions,
  getZkVaultStatus,
  listZkNoteCiphertexts,
  rotateZkVaultPassphrase,
  setupZkVault,
} from "../../src/server/dal/zk-vault";

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

  describe("passphrase rotation (AGENTS.md §3m amendment)", () => {
    it("rejects rotating a vault that was never set up", async () => {
      const result = await rotateZkVaultPassphrase(userB.id, {
        newSalt: "bmV3LXNhbHQ=",
        newIterations: 600_000,
        newCanaryCiphertext: "zk1:bmV3:bmV3",
        reencryptedNotes: [],
      });
      expect(result).toEqual({ ok: false, error: "not_set_up" });
    });

    it("listZkNoteCiphertexts returns only zk1:-formatted notes for the calling user, never a legacy v1: one or another user's", async () => {
      const zkNote = await admin.goalContribution.create({
        data: { userId: userA.id, goalId: goalA.id, amount: 7_000n, contributedAt: new Date(), note: "zk1:list-iv:list-ct" },
      });
      const legacyNote = await admin.goalContribution.create({
        data: {
          userId: userA.id,
          goalId: goalA.id,
          amount: 7_100n,
          contributedAt: new Date(),
          note: encryptField("still-legacy plaintext"),
        },
      });

      const notes = await listZkNoteCiphertexts(userA.id);
      expect(notes.some((n) => n.id === zkNote.id && n.note === "zk1:list-iv:list-ct")).toBe(true);
      expect(notes.map((n) => n.id)).not.toContain(legacyNote.id);

      // IDOR: userB's own call never sees userA's notes.
      const userBNotes = await listZkNoteCiphertexts(userB.id);
      expect(userBNotes.map((n) => n.id)).not.toContain(zkNote.id);
    });

    it("rejects a rotation whose submitted note-id set doesn't exactly match the CURRENT zk1: note set (concurrent edit)", async () => {
      const currentNotes = await listZkNoteCiphertexts(userA.id);

      // A note is added AFTER the client fetched `currentNotes` but
      // BEFORE it submits the rotation — the classic race this check
      // exists to close.
      await admin.goalContribution.create({
        data: { userId: userA.id, goalId: goalA.id, amount: 7_200n, contributedAt: new Date(), note: "zk1:race-iv:race-ct" },
      });

      const result = await rotateZkVaultPassphrase(userA.id, {
        newSalt: "cm90YXRlZC1zYWx0",
        newIterations: 700_000,
        newCanaryCiphertext: "zk1:cm90:cm90",
        reencryptedNotes: currentNotes.map((n) => ({ id: n.id, note: `zk1:stale-${n.id}:stale` })),
      });
      expect(result).toEqual({ ok: false, error: "notes_changed_concurrently" });

      // Confirms the rejected rotation touched NOTHING — original salt/
      // iterations/canary from the earlier "sets up the vault" test are
      // still exactly what's stored.
      await expect(getZkVaultStatus(userA.id)).resolves.toMatchObject({ salt: "dGVzdC1zYWx0", iterations: 600_000 });
    });

    it("atomically overwrites salt/iterations/canary AND every submitted note ciphertext", async () => {
      const currentNotes = await listZkNoteCiphertexts(userA.id);
      expect(currentNotes.length).toBeGreaterThan(0); // sanity: prior tests in this file seeded at least one zk1: note

      const reencryptedNotes = currentNotes.map((n) => ({ id: n.id, note: `zk1:rotated-${n.id}:rotated-ciphertext` }));

      const result = await rotateZkVaultPassphrase(userA.id, {
        newSalt: "cm90YXRlZC1zYWx0LXYy",
        newIterations: 700_000,
        newCanaryCiphertext: "zk1:cm90YXRlZA==:Y2FuYXJ5",
        reencryptedNotes,
      });
      expect(result).toEqual({ ok: true });

      await expect(getZkVaultStatus(userA.id)).resolves.toEqual({
        isSetUp: true,
        salt: "cm90YXRlZC1zYWx0LXYy",
        iterations: 700_000,
        canaryCiphertext: "zk1:cm90YXRlZA==:Y2FuYXJ5",
      });

      for (const note of reencryptedNotes) {
        const row = await admin.goalContribution.findUniqueOrThrow({ where: { id: note.id } });
        expect(row.note).toBe(note.note);
      }
    });

    it("does not affect a legacy (v1:) note that was never part of the rotation", async () => {
      const legacyNote = await admin.goalContribution.create({
        data: {
          userId: userA.id,
          goalId: goalA.id,
          amount: 7_300n,
          contributedAt: new Date(),
          note: encryptField("untouched by rotation"),
        },
      });

      const legacyNotesBefore = await findLegacyNoteContributions(userA.id);
      expect(legacyNotesBefore.some((n) => n.id === legacyNote.id)).toBe(true);

      const currentZkNotes = await listZkNoteCiphertexts(userA.id);
      const result = await rotateZkVaultPassphrase(userA.id, {
        newSalt: "YW5vdGhlci1yb3RhdGlvbg==",
        newIterations: 750_000,
        newCanaryCiphertext: "zk1:YW5vdGhlcg==:Y2FuYXJ5",
        reencryptedNotes: currentZkNotes.map((n) => ({ id: n.id, note: `zk1:another-${n.id}:x` })),
      });
      expect(result).toEqual({ ok: true });

      // The legacy note is still exactly what it was — untouched, still
      // in the OLD server-side format, unaffected by rotating the
      // zero-knowledge key its content never lived under.
      const legacyNotesAfter = await findLegacyNoteContributions(userA.id);
      expect(legacyNotesAfter.find((n) => n.id === legacyNote.id)).toEqual(
        legacyNotesBefore.find((n) => n.id === legacyNote.id),
      );
    });
  });
});
