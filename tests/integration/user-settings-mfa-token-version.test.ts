import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OTP } from "otplib";
import { createAdminClient } from "../../src/server/db/admin-client";
import { getOrCreateUserSettings, updateUserSettings } from "../../src/server/dal/user-settings";
import { beginTotpSetup, confirmTotpSetup, disableTotp, getMfaStatus } from "../../src/server/dal/mfa";
import { bumpTokenVersion, getCurrentTokenVersion } from "../../src/server/auth/token-version";

/**
 * Integration coverage for Punch List Tier 2 — global UserSettings
 * (item 1), server-side JWT revocation via tokenVersion (item 2), and
 * TOTP MFA (item 3) — against a REAL Postgres with RLS active, the same
 * "prove it against real rows, not just in-memory logic" bar every other
 * DAL module in this app is held to. Skipped without a live DB, same
 * convention as every other integration test.
 *
 * NOT run in this session: no live Postgres was reachable (Docker access
 * was blocked by this session's own permission classifier) — written to
 * the exact same pattern every other integration suite in this history
 * follows and typechecked cleanly, but the `it()` bodies below were never
 * actually executed against a real database. Flagged here plainly rather
 * than claimed as verified.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)(
  "UserSettings, JWT revocation (tokenVersion), and TOTP MFA",
  () => {
    let admin: ReturnType<typeof createAdminClient>;
    let userA: { id: string; email: string };
    let userB: { id: string; email: string };
    const createdUserIds: string[] = [];

    async function createTestUser(label: string): Promise<{ id: string; email: string }> {
      const user = await admin.user.create({
        data: { email: `settings-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@pfw.local`, displayName: `Settings Test ${label}` },
      });
      createdUserIds.push(user.id);
      return user;
    }

    beforeAll(async () => {
      admin = createAdminClient();
      userA = await createTestUser("a");
      userB = await createTestUser("b");
    });

    afterAll(async () => {
      await admin.user.deleteMany({ where: { id: { in: createdUserIds } } });
      await admin.$disconnect();
    });

    describe("UserSettings", () => {
      it("creates a row with schema defaults on first read, idempotently", async () => {
        const first = await getOrCreateUserSettings(userA.id);
        expect(first.taxJurisdiction).toBe("US");
        expect(first.taxMethod).toBe("FIFO");
        expect(first.taxOtherOrdinaryIncomeAgorot).toBe(0n);
        expect(first.preferredCurrencyDisplay).toBe("ILS");
        expect(first.defaultManualAssetLiquidityTier).toBeNull();

        const second = await getOrCreateUserSettings(userA.id);
        expect(second).toEqual(first);
      });

      it("applies a partial update, leaving untouched fields as-is", async () => {
        await getOrCreateUserSettings(userA.id);
        const updated = await updateUserSettings(userA.id, {
          taxJurisdiction: "DE",
          preferredCurrencyDisplay: "NATIVE",
          monteCarloTargetAnnualSpendAgorot: 12_000_00n,
        });

        expect(updated.taxJurisdiction).toBe("DE");
        expect(updated.preferredCurrencyDisplay).toBe("NATIVE");
        expect(updated.monteCarloTargetAnnualSpendAgorot).toBe(12_000_00n);
        // Untouched field keeps its prior default.
        expect(updated.taxMethod).toBe("FIFO");
      });

      it("keeps two users' settings rows fully isolated (IDOR)", async () => {
        await updateUserSettings(userA.id, { taxJurisdiction: "DE" });
        const bSettings = await getOrCreateUserSettings(userB.id);
        expect(bSettings.taxJurisdiction).toBe("US"); // B's own default, unaffected by A's update
      });
    });

    describe("Server-side JWT revocation (tokenVersion)", () => {
      it("starts at 1 and increments on bump", async () => {
        const user = await createTestUser("tv1");
        const initial = await getCurrentTokenVersion(user.id);
        expect(initial).toBe(1);

        const bumped = await bumpTokenVersion(user.id);
        expect(bumped).toBe(2);

        const readBack = await getCurrentTokenVersion(user.id);
        expect(readBack).toBe(2);
      });

      it("bumping one user's tokenVersion never affects another user's (IDOR)", async () => {
        const bumpedUser = await createTestUser("tv2a");
        const untouchedUser = await createTestUser("tv2b");
        const before = await getCurrentTokenVersion(untouchedUser.id);
        await bumpTokenVersion(bumpedUser.id);
        const after = await getCurrentTokenVersion(untouchedUser.id);
        expect(after).toBe(before);
      });

      it("returns null for a nonexistent user id", async () => {
        const version = await getCurrentTokenVersion("nonexistent-user-id");
        expect(version).toBeNull();
      });
    });

    describe("TOTP MFA", () => {
      // Every test below creates its own fresh user — MFA state (secret,
      // enabled, replay-protection time step) is mutated sequentially by
      // design, and sharing one user across independent assertions would
      // make a later test's outcome depend on an earlier one's, the
      // opposite of what these are meant to prove in isolation.

      it("begins setup as PENDING (secret set, not yet enabled)", async () => {
        const user = await createTestUser("mfa1");
        const { secret, otpauthUri } = await beginTotpSetup(user.id, user.email);
        expect(secret.length).toBeGreaterThan(0);
        expect(otpauthUri).toMatch(/^otpauth:\/\/totp\//);

        const status = await getMfaStatus(user.id);
        expect(status).toEqual({ enabled: false, pending: true });
      });

      it("confirming with a correct code enables MFA", async () => {
        const user = await createTestUser("mfa2");
        const { secret } = await beginTotpSetup(user.id, user.email);
        const otp = new OTP({ strategy: "totp" });
        const code = await otp.generate({ secret });

        const result = await confirmTotpSetup(user.id, code);
        expect(result).toEqual({ ok: true });

        const status = await getMfaStatus(user.id);
        expect(status).toEqual({ enabled: true, pending: false });
      });

      it("confirming with a wrong code fails and leaves MFA unconfirmed", async () => {
        const user = await createTestUser("mfa3");
        await beginTotpSetup(user.id, user.email);
        const result = await confirmTotpSetup(user.id, "000000");
        expect(result).toEqual({ ok: false, error: "invalid_code" });

        const status = await getMfaStatus(user.id);
        expect(status).toEqual({ enabled: false, pending: true });
      });

      it("rejects confirmation when no setup was ever started", async () => {
        const user = await createTestUser("mfa4");
        const result = await confirmTotpSetup(user.id, "123456");
        expect(result).toEqual({ ok: false, error: "no_pending_setup" });
      });

      it("disabling MFA clears state AND bumps tokenVersion (invalidating other sessions)", async () => {
        const user = await createTestUser("mfa5");
        const { secret } = await beginTotpSetup(user.id, user.email);
        const otp = new OTP({ strategy: "totp" });
        const code = await otp.generate({ secret });
        await confirmTotpSetup(user.id, code);

        const versionBefore = await getCurrentTokenVersion(user.id);
        await disableTotp(user.id);
        const versionAfter = await getCurrentTokenVersion(user.id);

        expect(versionAfter).toBe((versionBefore ?? 0) + 1);

        const status = await getMfaStatus(user.id);
        expect(status).toEqual({ enabled: false, pending: false });
      });

      it("replay protection: the SAME accepted code can never confirm twice", async () => {
        const user = await createTestUser("mfa6");
        const { secret } = await beginTotpSetup(user.id, user.email);
        const otp = new OTP({ strategy: "totp" });
        const code = await otp.generate({ secret });

        const first = await confirmTotpSetup(user.id, code);
        expect(first).toEqual({ ok: true });

        // Re-confirming the IDENTICAL code against the still-stored
        // secret must fail, since totpLastUsedTimeStep now matches this
        // code's own time step — proving the mechanism directly rather
        // than waiting up to 30s for a real new code to become available.
        const replay = await confirmTotpSetup(user.id, code);
        expect(replay.ok).toBe(false);
      });
    });
  },
);
