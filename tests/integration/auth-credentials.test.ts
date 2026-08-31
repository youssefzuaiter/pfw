import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { registerUser, verifyCredentials } from "../../src/server/auth/credentials";
import { createAdminClient } from "../../src/server/db/admin-client";

/**
 * Integration coverage for real authentication's bootstrap operations
 * (AGENTS.md §3ff) — the "first registration inherits the seeded demo
 * data" mechanism specifically, since that's the one piece of logic
 * genuinely worth getting a test-proven guarantee on: it's a one-way
 * door (once claimed, never unclaimed again) touching real financial
 * demo data.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("Real authentication — credentials", () => {
  let admin: ReturnType<typeof createAdminClient>;
  const testEmails: string[] = [];
  let demoUserId: string | null = null;
  let demoUserOriginalPasswordHash: string | null = null;

  beforeAll(async () => {
    admin = createAdminClient();
    // This suite deliberately touches the REAL primary demo user row
    // (there's exactly one, and registerUser() specifically targets it
    // by email) — save its original state so it can be restored, the
    // same "don't leave the shared local dev DB worse than found it"
    // discipline every other live-verified feature in this app follows.
    const demoUser = await admin.user.findUnique({ where: { email: "demo@pfw.local" } });
    if (demoUser) {
      demoUserId = demoUser.id;
      demoUserOriginalPasswordHash = demoUser.passwordHash;
    }
  });

  afterEach(async () => {
    // Order matters here, and getting it backwards is a real bug this
    // file's own first draft hit: when a test claims the demo account,
    // registerUser() renames ITS row's email to that test's email — so
    // restoring the demo row back to "demo@pfw.local" MUST happen
    // BEFORE deleting-by-testEmails, or that delete matches the demo
    // row's CURRENT (still-claimed) email and removes it entirely,
    // leaving the restore below to throw updating a row that no longer
    // exists. The `id: { not: demoUserId }` guard is defense-in-depth
    // on top of the reordering, not a substitute for it.
    if (demoUserId) {
      await admin.user.update({
        where: { id: demoUserId },
        data: { email: "demo@pfw.local", passwordHash: demoUserOriginalPasswordHash, displayName: "Demo User" },
      });
    }
    if (testEmails.length > 0) {
      await admin.user.deleteMany({
        where: { email: { in: testEmails }, ...(demoUserId ? { id: { not: demoUserId } } : {}) },
      });
      testEmails.length = 0;
    }
  });

  afterAll(async () => {
    await admin.$disconnect();
  });

  it("the first registration while the demo account is unclaimed inherits it — same row, new email/password", async () => {
    if (!demoUserId) return; // no demo user in this DB — nothing to inherit, skip gracefully
    const newEmail = `inherit-test-${Date.now()}@pfw.local`;
    testEmails.push(newEmail);

    const result = await registerUser(newEmail, "correcthorsebattery", "Inherit Test");
    expect(result).toMatchObject({ ok: true, inherited: true, userId: demoUserId });

    const row = await admin.user.findUnique({ where: { id: demoUserId } });
    expect(row?.email).toBe(newEmail);
    expect(row?.passwordHash).not.toBeNull();
  });

  it("registering with the literal demo email while unclaimed still correctly claims it (no false 'email taken')", async () => {
    if (!demoUserId) return;
    const result = await registerUser("demo@pfw.local", "correcthorsebattery", "Claimed As Demo");
    expect(result).toMatchObject({ ok: true, inherited: true, userId: demoUserId });
  });

  it("a SECOND registration, once the demo account is already claimed, creates a genuinely fresh row", async () => {
    if (!demoUserId) return;
    const firstEmail = `first-claim-${Date.now()}@pfw.local`;
    const secondEmail = `second-fresh-${Date.now()}@pfw.local`;
    testEmails.push(firstEmail, secondEmail);

    const first = await registerUser(firstEmail, "correcthorsebattery", "First");
    expect(first).toMatchObject({ ok: true, inherited: true, userId: demoUserId });

    const second = await registerUser(secondEmail, "anotherrealpassword", "Second");
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.inherited).toBe(false);
      expect(second.userId).not.toBe(demoUserId);
      testEmails.push(secondEmail);

      const row = await admin.user.findUnique({ where: { id: second.userId } });
      expect(row?.email).toBe(secondEmail);
    }
  });

  it("never claims a household-member row (unclaimed for a different reason — §3s, not §3ff)", async () => {
    const spouse = await admin.user.findUnique({ where: { email: "dana@pfw.local" } });
    if (!spouse) return; // household seed data not present in this DB
    expect(spouse.passwordHash).toBeNull();

    const newEmail = `not-dana-${Date.now()}@pfw.local`;
    testEmails.push(newEmail);
    const result = await registerUser(newEmail, "correcthorsebattery", "Not Dana");

    // Must never touch Dana's row — either inherits the PRIMARY demo
    // user (if still unclaimed) or creates a fresh row, never Dana's id.
    if (result.ok) {
      expect(result.userId).not.toBe(spouse.id);
    }
    const spouseAfter = await admin.user.findUnique({ where: { id: spouse.id } });
    expect(spouseAfter?.passwordHash).toBeNull();
    expect(spouseAfter?.email).toBe("dana@pfw.local");
  });

  it("rejects registering with an email that's already taken by a different user", async () => {
    const email = `taken-${Date.now()}@pfw.local`;
    testEmails.push(email);
    const first = await registerUser(email, "correcthorsebattery", "Original Owner");
    expect(first.ok).toBe(true);

    const second = await registerUser(email, "differentpassword", "Impersonator");
    expect(second).toEqual({ ok: false, error: "email_taken" });
  });

  it("verifyCredentials returns the user for correct credentials, null for wrong password, null for unknown email", async () => {
    const email = `verify-test-${Date.now()}@pfw.local`;
    testEmails.push(email);
    await registerUser(email, "correcthorsebattery", "Verify Test");

    const correct = await verifyCredentials(email, "correcthorsebattery");
    expect(correct?.email).toBe(email);

    const wrongPassword = await verifyCredentials(email, "totallywrongpassword");
    expect(wrongPassword).toBeNull();

    const unknownEmail = await verifyCredentials("nobody-real@pfw.local", "whatever12345");
    expect(unknownEmail).toBeNull();
  });

  it("verifyCredentials returns null for an unclaimed row (no password set yet), never a false accept", async () => {
    const spouse = await admin.user.findUnique({ where: { email: "dana@pfw.local" } });
    if (!spouse) return;
    const result = await verifyCredentials("dana@pfw.local", "anything-at-all");
    expect(result).toBeNull();
  });
});
