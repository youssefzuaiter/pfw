import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptField, encryptField, getActiveEncryptionKeyId } from "./field-encryption";
import type { AdminClient } from "./key-rotation";

/**
 * Deliberately NOT an integration test against real Postgres, unlike
 * every other admin-client batch job in this app (`inactivity-check.ts`,
 * `quote-sync.ts`). Those are naturally SAFE to run against the shared
 * dev database under Vitest's parallel test-file execution because
 * they're no-ops for a row created by some unrelated, concurrently-
 * running test file (a fresh `DeadMansSwitch`/`PortfolioHolding` row is
 * nowhere near any elapsed-time threshold). This module's sweep is NOT
 * a no-op for an unrelated fresh row — it unconditionally re-keys ANY
 * row in these six tables that isn't yet on the target key, regardless
 * of which test created it. Running the real sweep against the shared
 * dev database while other integration test files are concurrently
 * writing to `BankAccount`/`NotableTransaction`/`User`/`BankConnection`/
 * `RecoveryShareSubmission`/`GoalContribution` would risk re-encrypting
 * one of THEIR fresh rows mid-test, under a throwaway key their own
 * process doesn't know about — an intermittent, hard-to-diagnose
 * cross-file failure this suite must never introduce.
 *
 * The real SQL and the full end-to-end round trip (rotate onto a new
 * key, verify, rotate back, confirm nothing was left corrupted) were
 * instead verified by hand against the real local database, in an
 * isolated window with no other test workers running — see the
 * conversation record for that walkthrough. What's tested here is the
 * orchestration: read-then-write-back sequencing, per-row error
 * isolation, the `zk1:` exclusion, and the top-level no-op guard — all
 * provable with small, hand-built fake clients and zero real DB access.
 */

vi.mock("../db/admin-client", () => ({ createAdminClient: vi.fn() }));

const originalKey = process.env.ENCRYPTION_KEY;
const originalNextKey = process.env.ENCRYPTION_KEY_NEXT;

function resetKeys(): void {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.ENCRYPTION_KEY_NEXT;
}

afterEach(() => {
  vi.clearAllMocks();
  if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = originalKey;
  if (originalNextKey === undefined) delete process.env.ENCRYPTION_KEY_NEXT;
  else process.env.ENCRYPTION_KEY_NEXT = originalNextKey;
});

describe("runEncryptionKeyRotationSweep() — the top-level no-op guard", () => {
  beforeEach(resetKeys);

  it("returns immediately with zero database access when ENCRYPTION_KEY_NEXT is unset", async () => {
    const { createAdminClient } = await import("../db/admin-client");
    const { runEncryptionKeyRotationSweep } = await import("./key-rotation");

    const result = await runEncryptionKeyRotationSweep();

    expect(result).toEqual({ ok: true, inProgress: false });
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});

describe("runEncryptionKeyRotationSweep() — orchestration across all six tables", () => {
  beforeEach(resetKeys);

  function emptyQueryRaw() {
    // Matches the shape every sweep function expects back-to-back: the
    // "which ids are stale" select, then the "how many remain" count.
    return vi.fn().mockImplementation((strings: TemplateStringsArray) => {
      const sql = strings.join("");
      if (sql.includes("count(*)")) return Promise.resolve([{ count: 0n }]);
      return Promise.resolve([]);
    });
  }

  function makeEmptyFakeAdmin(): AdminClient {
    const noop = { findUniqueOrThrow: vi.fn(), update: vi.fn() };
    return {
      $queryRaw: emptyQueryRaw(),
      $disconnect: vi.fn().mockResolvedValue(undefined),
      bankAccount: { ...noop },
      notableTransaction: { ...noop },
      user: { ...noop },
      bankConnection: { ...noop },
      recoveryShareSubmission: { findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
      goalContribution: { findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
    } as unknown as AdminClient;
  }

  it("reports 0 reencrypted/remaining/failed when nothing anywhere needs migrating", async () => {
    process.env.ENCRYPTION_KEY_NEXT = randomBytes(32).toString("base64");
    const { createAdminClient } = await import("../db/admin-client");
    const fakeAdmin = makeEmptyFakeAdmin();
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin);

    const { runEncryptionKeyRotationSweep } = await import("./key-rotation");
    const result = await runEncryptionKeyRotationSweep();

    expect(result).toEqual({ ok: true, inProgress: true, reencrypted: 0, remaining: 0, failed: 0 });
    expect(fakeAdmin.$disconnect).toHaveBeenCalledTimes(1);
  });

  it("catches a total sweep failure (e.g. a lost DB connection) and still disconnects", async () => {
    process.env.ENCRYPTION_KEY_NEXT = randomBytes(32).toString("base64");
    const { createAdminClient } = await import("../db/admin-client");
    const fakeAdmin = makeEmptyFakeAdmin();
    vi.mocked(fakeAdmin.$queryRaw).mockRejectedValueOnce(new Error("connection terminated"));
    vi.mocked(createAdminClient).mockReturnValue(fakeAdmin);

    const { runEncryptionKeyRotationSweep } = await import("./key-rotation");
    const result = await runEncryptionKeyRotationSweep();

    expect(result).toEqual({ ok: false, inProgress: true, error: "connection terminated" });
    expect(fakeAdmin.$disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("sweepBankAccountLast4() — the extension-managed read-then-write-back shape", () => {
  it("re-encrypts every stale row via a plain read-then-write-back round trip", async () => {
    const { sweepBankAccountLast4 } = await import("./key-rotation");
    const values: Record<string, string> = { a: "v1:iv-a:tag-a:ct-a", b: "v1:iv-b:tag-b:ct-b" };
    const fakeAdmin = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: "a" }, { id: "b" }])
        .mockResolvedValueOnce([{ count: 0n }]),
      bankAccount: {
        findUniqueOrThrow: vi.fn().mockImplementation(({ where: { id } }: { where: { id: string } }) =>
          Promise.resolve({ last4: values[id] }),
        ),
        update: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as AdminClient;

    const result = await sweepBankAccountLast4(fakeAdmin, "v2:newkid:");

    expect(result).toEqual({ reencrypted: 2, failed: 0, remaining: 0 });
    expect(fakeAdmin.bankAccount.update).toHaveBeenCalledWith({ where: { id: "a" }, data: { last4: "v1:iv-a:tag-a:ct-a" } });
    expect(fakeAdmin.bankAccount.update).toHaveBeenCalledWith({ where: { id: "b" }, data: { last4: "v1:iv-b:tag-b:ct-b" } });
  });

  it("counts a per-row failure without aborting the rest of the batch", async () => {
    const { sweepBankAccountLast4 } = await import("./key-rotation");
    const fakeAdmin = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: "a" }, { id: "b" }])
        .mockResolvedValueOnce([{ count: 1n }]),
      bankAccount: {
        findUniqueOrThrow: vi.fn().mockImplementation(({ where: { id } }: { where: { id: string } }) =>
          id === "a" ? Promise.reject(new Error("row vanished")) : Promise.resolve({ last4: "v1:iv:tag:ct" }),
        ),
        update: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as AdminClient;

    const result = await sweepBankAccountLast4(fakeAdmin, "v2:newkid:");

    expect(result).toEqual({ reencrypted: 1, failed: 1, remaining: 1 });
    // "b" still got touched even though "a" failed first.
    expect(fakeAdmin.bankAccount.update).toHaveBeenCalledWith({ where: { id: "b" }, data: { last4: "v1:iv:tag:ct" } });
    expect(fakeAdmin.bankAccount.update).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: "a" } }));
  });
});

describe("sweepRecoveryShareSubmissions() and sweepLegacyGoalContributionNotes() — the manual-codec shape", () => {
  const originalTestKey = process.env.ENCRYPTION_KEY;
  const originalTestNextKey = process.env.ENCRYPTION_KEY_NEXT;

  beforeEach(resetKeys);

  afterEach(() => {
    if (originalTestKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalTestKey;
    if (originalTestNextKey === undefined) delete process.env.ENCRYPTION_KEY_NEXT;
    else process.env.ENCRYPTION_KEY_NEXT = originalTestNextKey;
  });

  it("re-encrypts a legacy RecoveryShareSubmission row and the result genuinely decrypts back to the original value", async () => {
    const legacyCiphertext = encryptField("a-real-shamir-share-payload");

    process.env.ENCRYPTION_KEY_NEXT = randomBytes(32).toString("base64");
    const prefix = `v2:${getActiveEncryptionKeyId()}:`;

    const { sweepRecoveryShareSubmissions } = await import("./key-rotation");
    const fakeAdmin = {
      recoveryShareSubmission: {
        findMany: vi.fn().mockResolvedValue([{ id: "s1", shareValueCiphertext: legacyCiphertext }]),
        update: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as AdminClient;

    const result = await sweepRecoveryShareSubmissions(fakeAdmin, prefix);

    expect(result).toEqual({ reencrypted: 1, failed: 0, remaining: 0 });
    const [[{ data }]] = vi.mocked(fakeAdmin.recoveryShareSubmission.update).mock.calls as unknown as [
      [{ data: { shareValueCiphertext: string } }],
    ];
    expect(data.shareValueCiphertext.startsWith(prefix)).toBe(true);
    expect(decryptField(data.shareValueCiphertext)).toBe("a-real-shamir-share-payload");
  });

  it("never touches a RecoveryShareSubmission row already on the new key", async () => {
    process.env.ENCRYPTION_KEY_NEXT = randomBytes(32).toString("base64");
    const prefix = `v2:${getActiveEncryptionKeyId()}:`;
    const alreadyMigrated = `${prefix}iv:tag:ct`;

    const { sweepRecoveryShareSubmissions } = await import("./key-rotation");
    const fakeAdmin = {
      recoveryShareSubmission: {
        findMany: vi.fn().mockResolvedValue([{ id: "s1", shareValueCiphertext: alreadyMigrated }]),
        update: vi.fn(),
      },
    } as unknown as AdminClient;

    const result = await sweepRecoveryShareSubmissions(fakeAdmin, prefix);

    expect(result).toEqual({ reencrypted: 0, failed: 0, remaining: 0 });
    expect(fakeAdmin.recoveryShareSubmission.update).not.toHaveBeenCalled();
  });

  it("re-encrypts a legacy GoalContribution.note but NEVER a real zero-knowledge (zk1:) note", async () => {
    const legacyNote = encryptField("First deposit, before the vault existed");
    const zkNote = "zk1:some-real-client-side-ciphertext-the-server-cannot-decrypt";

    process.env.ENCRYPTION_KEY_NEXT = randomBytes(32).toString("base64");
    const prefix = `v2:${getActiveEncryptionKeyId()}:`;

    const { sweepLegacyGoalContributionNotes } = await import("./key-rotation");
    const fakeAdmin = {
      goalContribution: {
        findMany: vi.fn().mockResolvedValue([
          { id: "legacy-1", note: legacyNote },
          { id: "zk-1", note: zkNote },
        ]),
        update: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as AdminClient;

    const result = await sweepLegacyGoalContributionNotes(fakeAdmin, prefix);

    expect(result).toEqual({ reencrypted: 1, failed: 0, remaining: 0 });
    expect(fakeAdmin.goalContribution.update).toHaveBeenCalledTimes(1);
    const [[{ where, data }]] = vi.mocked(fakeAdmin.goalContribution.update).mock.calls as unknown as [
      [{ where: { id: string }; data: { note: string } }],
    ];
    expect(where.id).toBe("legacy-1");
    expect(decryptField(data.note)).toBe("First deposit, before the vault existed");
  });
});
