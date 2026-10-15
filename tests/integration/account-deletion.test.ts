import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import { CROSS_TENANT_FOREIGN_KEYS, deleteAccount } from "../../src/server/account/delete-account";
import { createTransaction, updateTransactionCategory } from "../../src/server/dal/transactions";
import { recordAuditLog } from "../../src/server/dal/audit-log";
import { enablePhoneAlerts } from "../../src/server/dal/phone-alerts";
import { getOrCreateUserSettings } from "../../src/server/dal/user-settings";
import { recordNetWorthSnapshot } from "../../src/server/dal/net-worth";
import { verifyLedgerChain } from "../../src/server/dal/ledger-commits";
import { getCurrentTokenVersion } from "../../src/server/auth/token-version";

/**
 * Account deletion against real Postgres with RLS and the append-only
 * triggers (AGENTS.md §3ttt).
 *
 * User A gets a full profile: an encrypted bank account and TOTP secret,
 * transactions with hash-chained ledger commits, audit entries, an envelope,
 * a rule, a goal, phone alerts with an encrypted topic, an Emergency Vault, a
 * passkey, recovery codes, notifications, settings, a net-worth snapshot,
 * rate-limit windows, and a household that user B belongs to. After A is
 * deleted, nothing of A's may remain anywhere in the database (checked
 * against every table and column the database has, not a list kept here),
 * while B's rows are unchanged, B's ledger chains still verify, and the
 * append-only tables still refuse to change B's history.
 *
 * Cleanup uses deleteAccount itself, so the suite never disables a trigger.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("account deletion", () => {
  let admin: ReturnType<typeof createAdminClient>;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const users: Record<"a" | "b" | "c", { id: string; email: string }> = {} as never;
  const transactionsOf: Record<"a" | "b", string[]> = { a: [], b: [] };
  let bCategoryId = "";
  let cCategoryId = "";
  let aCiphertexts: string[] = [];

  /** Counts of rows per table for one user, over every table with a userId column. */
  async function rowCountsFor(userId: string): Promise<Record<string, number>> {
    const rows = await admin.$queryRaw<{ table_name: string; count: number }[]>`
      SELECT table_name::text,
             (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I WHERE "userId" = %L', table_name, ${userId}::text), false, true, '')))[1]::text::int AS count
      FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'userId'
    `;
    return Object.fromEntries(rows.map((row) => [row.table_name, row.count]));
  }

  /** Every place in the database a value appears: text, varchar and jsonb columns of every table. */
  async function whereValueAppears(needle: string, { exact }: { exact: boolean }): Promise<string[]> {
    const rows = await admin.$queryRaw<{ location: string; count: number }[]>`
      SELECT table_name || '.' || column_name AS location,
             (xpath('/row/c/text()', query_to_xml(
               CASE WHEN ${exact}::boolean
                 THEN format('SELECT count(*) AS c FROM %I WHERE %I::text = %L', table_name, column_name, ${needle}::text)
                 ELSE format('SELECT count(*) AS c FROM %I WHERE strpos(%I::text, %L) > 0', table_name, column_name, ${needle}::text)
               END, false, true, '')))[1]::text::int AS count
      FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type IN ('text', 'character varying', 'jsonb')
        AND table_name NOT IN ('_prisma_migrations', 'AccountDeletionRecord')
    `;
    return rows.filter((row) => row.count > 0).map((row) => row.location);
  }

  async function buildProfile(key: "a" | "b", label: string) {
    const user = await admin.user.create({
      data: { email: `deletion-${key}-${stamp}@pfw.local`, displayName: label, totpSecret: `JBSWY3DPEHPK3PXP${key.toUpperCase()}` },
    });
    users[key] = { id: user.id, email: user.email };

    const account = await admin.bankAccount.create({
      data: { userId: user.id, institutionName: `${label} Bank`, last4: key === "a" ? "4242" : "5353", accountType: "CHECKING", nativeBalance: 50_000n },
    });
    await admin.category.create({ data: { userId: user.id, slug: "uncategorized", name: "Uncategorized", isUncategorized: true } });
    const groceries = await admin.category.create({ data: { userId: user.id, slug: "groceries", name: "Groceries" } });
    if (key === "b") bCategoryId = groceries.id;

    for (const [index, description] of [`${label} market`, `${label} coffee`].entries()) {
      const created = await createTransaction(user.id, {
        bankAccountId: account.id,
        amountAgorot: BigInt(-1_000 * (index + 1)),
        occurredAt: new Date("2026-10-01T10:00:00Z"),
        description,
      });
      transactionsOf[key].push(created.id);
    }
    // A second commit on one chain, so a broken link would be visible.
    await updateTransactionCategory(user.id, transactionsOf[key][0], groceries.id);

    await recordAuditLog(user.id, { entityType: "Test", entityId: user.id, action: "CREATE", afterData: { email: user.email } });
    await admin.envelopeAllocation.create({ data: { userId: user.id, categoryId: groceries.id, month: "2026-10", amountAgorot: 10_000n } });
    await admin.transactionRule.create({
      data: {
        userId: user.id,
        name: `${label} rule`,
        conditions: [{ field: "merchantName", operator: "contains", value: "market" }],
        actions: [{ type: "categorize", value: "groceries" }],
      },
    });
    const goal = await admin.goal.create({ data: { userId: user.id, name: `${label} goal`, targetAmount: 100_000n } });
    await admin.goalContribution.create({ data: { userId: user.id, goalId: goal.id, amount: 5_000n, contributedAt: new Date() } });
    await admin.notification.create({ data: { userId: user.id, type: "test", message: `${label} notice` } });
    await admin.recoveryCode.create({ data: { userId: user.id, codeHash: `hash-${key}-${stamp}` } });
    await admin.authenticator.create({
      data: { userId: user.id, credentialId: `cred-${key}-${stamp}`, publicKey: new Uint8Array([1, 2, 3]), counter: 0n, deviceType: "singleDevice", backedUp: false, deviceLabel: "Test key" },
    });
    await enablePhoneAlerts(user.id, `pfw-deletion-topic-${key}-${stamp}`);
    await getOrCreateUserSettings(user.id);
    await recordNetWorthSnapshot(user.id, new Date("2026-10-13T00:00:00Z"));

    const vault = await admin.deadMansSwitch.create({
      data: { userId: user.id, totalShares: 2, thresholdShares: 2, vaultSalt: "salt", vaultKdfIterations: 600_000, vaultCanaryCiphertext: "dms1:canary" },
    });
    await admin.beneficiary.create({
      data: { userId: user.id, deadMansSwitchId: vault.id, label: "Sibling", shareIndex: 1, shareHash: "share-hash", inviteTokenHash: `invite-${key}-${stamp}` },
    });
    await admin.emergencyDocument.create({ data: { userId: user.id, deadMansSwitchId: vault.id, title: "Will", ciphertext: `dms1:doc-${key}-${stamp}` } });

    await admin.$executeRaw`
      INSERT INTO "RateLimitBucket" ("key", "windowStart", "count", "expiresAt")
      VALUES (${`notifications:get:${user.id}`}, 0, 1, now() + interval '1 hour'),
             (${`auth:login:${user.email}`}, 0, 1, now() + interval '1 hour')
    `;
  }

  beforeAll(async () => {
    admin = createAdminClient();
    await buildProfile("a", "Alice");
    await buildProfile("b", "Bob");

    // A owns a household B belongs to, and B has shared a category into it.
    const group = await admin.sharedGroup.create({ data: { name: "Deletion household", createdById: users.a.id } });
    await admin.groupMember.create({ data: { sharedGroupId: group.id, userId: users.a.id, role: "OWNER", permission: "WRITE" } });
    await admin.groupMember.create({ data: { sharedGroupId: group.id, userId: users.b.id, role: "MEMBER", permission: "WRITE" } });
    await admin.category.update({ where: { id: bCategoryId }, data: { sharedGroupId: group.id } });

    const c = await admin.user.create({ data: { email: `deletion-c-${stamp}@pfw.local`, displayName: "Carol" } });
    users.c = { id: c.id, email: c.email };
    cCategoryId = (await admin.category.create({ data: { userId: c.id, slug: "travel", name: "Travel" } })).id;

    const raw = await admin.$queryRaw<{ value: string }[]>`
      SELECT "description" AS value FROM "NotableTransaction" WHERE "userId" = ${users.a.id}
      UNION ALL SELECT "last4" FROM "BankAccount" WHERE "userId" = ${users.a.id}
      UNION ALL SELECT "totpSecret" FROM "User" WHERE "id" = ${users.a.id}
      UNION ALL SELECT "topic" FROM "PhoneAlertSubscription" WHERE "userId" = ${users.a.id}
      UNION ALL SELECT "ciphertext" FROM "EmergencyDocument" WHERE "userId" = ${users.a.id}
    `;
    aCiphertexts = raw.map((row) => row.value);
  });

  afterAll(async () => {
    for (const key of ["a", "b", "c"] as const) {
      if (users[key]) await deleteAccount(users[key].id);
    }
    const ids = Object.values(users).map((user) => user.id);
    await admin.accountDeletionRecord.deleteMany({ where: { deletedUserId: { in: ids } } });
    await admin.$disconnect();
  });

  it("starts from a real profile: encrypted values at rest and two verified ledger chains", async () => {
    // Two descriptions, last4, the TOTP secret and the alert topic are
    // server-encrypted; the vault document is the browser's own ciphertext.
    expect(aCiphertexts).toHaveLength(6);
    expect(aCiphertexts.filter((value) => /^v[12]:/.test(value))).toHaveLength(5);
    for (const id of transactionsOf.a) expect((await verifyLedgerChain(users.a.id, id)).valid).toBe(true);
    const counts = await rowCountsFor(users.a.id);
    expect(counts.LedgerCommit).toBe(3);
    expect(counts.AuditLog).toBeGreaterThanOrEqual(1);
    expect(counts.GroupMember).toBe(1);
  });

  it("checks every foreign key between two users' tables for cross-account references", async () => {
    const rows = await admin.$queryRaw<{ ref: string }[]>`
      SELECT child.relname || '.' || att.attname AS ref
      FROM pg_constraint con
      JOIN pg_class child ON child.oid = con.conrelid
      JOIN pg_class parent ON parent.oid = con.confrelid
      JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
      WHERE con.contype = 'f'
        AND parent.relname <> 'User'
        AND EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = child.relname AND c.column_name = 'userId')
        AND EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = parent.relname AND c.column_name = 'userId')
    `;
    expect(rows.map((row) => row.ref).sort()).toEqual([...CROSS_TENANT_FOREIGN_KEYS].sort());
  });

  it("refuses, and changes nothing, when another user's row points at the account's data", async () => {
    // B's transaction filed under C's category: the app never does this,
    // but the database would let the cascade delete B's transaction.
    const bTransaction = transactionsOf.b[1];
    const [{ categoryId: original }] = await admin.$queryRaw<{ categoryId: string }[]>`SELECT "categoryId" FROM "NotableTransaction" WHERE "id" = ${bTransaction}`;
    await admin.$executeRaw`UPDATE "NotableTransaction" SET "categoryId" = ${cCategoryId} WHERE "id" = ${bTransaction}`;
    const before = await rowCountsFor(users.c.id);

    const result = await deleteAccount(users.c.id);

    expect(result).toEqual({ ok: false, error: "cross_tenant_reference", references: ["NotableTransaction.categoryId"] });
    expect(await admin.user.count({ where: { id: users.c.id } })).toBe(1);
    expect(await rowCountsFor(users.c.id)).toEqual(before);
    expect(await admin.accountDeletionRecord.count({ where: { deletedUserId: users.c.id } })).toBe(0);
    await admin.$executeRaw`UPDATE "NotableTransaction" SET "categoryId" = ${original} WHERE "id" = ${bTransaction}`;
  });

  it("deletes the account completely while the other user's data and history stay intact", async () => {
    const bBefore = await rowCountsFor(users.b.id);

    expect(await deleteAccount(users.a.id)).toEqual({ ok: true });

    // Nothing of A's is left in any table with a userId column...
    const aAfter = await rowCountsFor(users.a.id);
    expect(Object.entries(aAfter).filter(([, count]) => count > 0)).toEqual([]);
    expect(await admin.user.count({ where: { id: users.a.id } })).toBe(0);
    expect(await admin.sharedGroup.count({ where: { createdById: users.a.id } })).toBe(0);

    // ...nor anywhere else: no ciphertext, no email, no id, in any column of any table.
    for (const value of aCiphertexts) expect(await whereValueAppears(value, { exact: true })).toEqual([]);
    expect(await whereValueAppears(users.a.email, { exact: false })).toEqual([]);
    expect(await whereValueAppears(users.a.id, { exact: false })).toEqual([]);

    // Only the deletion record remembers the id.
    expect(await admin.accountDeletionRecord.count({ where: { deletedUserId: users.a.id } })).toBe(1);

    // B: every row is still there except B's membership of A's household,
    // and B's category is no longer shared into a group that is gone.
    const bAfter = await rowCountsFor(users.b.id);
    expect(bAfter.GroupMember).toBe(0);
    expect({ ...bAfter, GroupMember: bBefore.GroupMember }).toEqual(bBefore);
    expect((await admin.category.findUniqueOrThrow({ where: { id: bCategoryId } })).sharedGroupId).toBeNull();
    for (const id of transactionsOf.b) expect(await verifyLedgerChain(users.b.id, id)).toEqual({ valid: true, brokenAtCommitId: null, mismatchedFields: [] });
    expect(await admin.rateLimitBucket.count({ where: { key: `notifications:get:${users.b.id}` } })).toBe(1);
  });

  it("ends A's sessions: the per-request token check no longer finds the user", async () => {
    expect(await getCurrentTokenVersion(users.a.id)).toBeNull();
  });

  it("leaves the append-only tables append-only for everyone still here", async () => {
    const bId = users.b.id;
    await expect(admin.$executeRaw`UPDATE "AuditLog" SET "entityType" = 'tampered' WHERE "userId" = ${bId}`).rejects.toThrow(/append-only/);
    await expect(admin.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ${bId}`).rejects.toThrow(/append-only/);
    await expect(admin.$executeRaw`UPDATE "LedgerCommit" SET "currentHash" = 'x' WHERE "userId" = ${bId}`).rejects.toThrow(/append-only/);
    await expect(admin.$executeRaw`DELETE FROM "LedgerCommit" WHERE "userId" = ${bId}`).rejects.toThrow(/append-only/);

    // The purge flag alone is not enough: B's User row still exists.
    for (const table of ["AuditLog", "LedgerCommit"] as const) {
      await expect(
        admin.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT set_config('pfw.purge_user_id', ${bId}, true)`;
          if (table === "AuditLog") await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ${bId}`;
          else await tx.$executeRaw`DELETE FROM "LedgerCommit" WHERE "userId" = ${bId}`;
        }),
      ).rejects.toThrow(/append-only/);
    }
    // Nor is it enough to name a different user than the row's owner.
    await expect(
      admin.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('pfw.purge_user_id', ${users.a.id}, true)`;
        await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ${bId}`;
      }),
    ).rejects.toThrow(/append-only/);

    expect((await rowCountsFor(bId)).AuditLog).toBeGreaterThanOrEqual(1);
  });

  it("answers not_found for an account that does not exist", async () => {
    expect(await deleteAccount(`missing-${stamp}`)).toEqual({ ok: false, error: "not_found" });
  });
});
