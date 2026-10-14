import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import { encryptField } from "../../src/server/crypto/field-encryption";
import { gatherUserExport } from "../../src/server/dal/data-export";
import { packageCsvExport, packageJsonExport } from "../../src/server/data-export/package-export";
import { deleteAccount } from "../../src/server/account/delete-account";
import { EXPORT_TABLES, REDACTED_HOUSEHOLD, REDACTED_PERSON } from "../../src/lib/data-export/format";

/**
 * The data export against real Postgres with RLS (AGENTS.md §3uuu).
 *
 * Users A and B are built to collide: the same category names, the same
 * dates, the same amounts, encrypted descriptions and account numbers. They
 * are also housemates both ways (each a member of a household the other
 * owns, each sharing a category into it), which is precisely the case where
 * the database's own policies let A READ some of B's rows. A's own audit log
 * and invites name B.
 *
 * The export is made as A, packaged as JSON and as a ZIP of CSVs, and every
 * byte of both is searched: every piece of A's decrypted plaintext must be
 * there, and nothing of B's — no text, id, email, ciphertext — anywhere.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("data export", () => {
  let admin: ReturnType<typeof createAdminClient>;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const SAME_DAY = new Date("2026-10-01T09:30:00Z");
  const A: Record<string, string> = {};
  const B: Record<string, string> = {};
  /** Plaintext of A's that must appear. */
  const aPlaintext: string[] = [];
  /** Anything of B's that must not appear. */
  const bTraces: string[] = [];
  /** A's stored ciphertexts: the export must hold the decrypted value instead. */
  const aCiphertexts: string[] = [];
  let jsonText = "";
  let csvFiles: Record<string, string> = {};
  let csvText = "";

  async function seed(who: "A" | "B", ids: Record<string, string>, unique: string) {
    const user = await admin.user.create({
      data: { email: `export-${who.toLowerCase()}-${stamp}@pfw.local`, displayName: `${unique} Person`, totpSecret: `JBSWY3DP${who}${who}${who}${who}EHPK3PXP` },
    });
    ids.id = user.id;
    ids.email = user.email;
    const account = await admin.bankAccount.create({
      data: { userId: user.id, institutionName: `${unique} Bank`, last4: who === "A" ? "1111" : "8888", accountType: "CHECKING", nativeBalance: 50_000n },
    });
    ids.account = account.id;
    // Same name, same slug for both users.
    const groceries = await admin.category.create({ data: { userId: user.id, slug: "groceries", name: "Groceries" } });
    ids.category = groceries.id;
    const transaction = await admin.notableTransaction.create({
      data: {
        userId: user.id,
        bankAccountId: account.id,
        categoryId: groceries.id,
        occurredAt: SAME_DAY,
        amount: -12_550n,
        nativeAmount: -12_550n,
        description: `${unique} secret purchase memo`,
        merchantName: `${unique} Market`,
        isManual: true,
        needsReview: false,
      },
    });
    ids.transaction = transaction.id;
    const goal = await admin.goal.create({ data: { userId: user.id, name: `${unique} goal`, targetAmount: 100_000n } });
    await admin.goalContribution.create({
      data: { userId: user.id, goalId: goal.id, amount: 5_000n, contributedAt: SAME_DAY, note: encryptField(`${unique} legacy note`) },
    });
    await admin.notification.create({ data: { userId: user.id, type: "test", message: `${unique} notice` } });
    await admin.phoneAlertSubscription.create({ data: { userId: user.id, topic: `pfw-export-topic-${who}-${stamp}` } });
    return user;
  }

  beforeAll(async () => {
    admin = createAdminClient();
    await seed("A", A, `Alpha${stamp}`);
    await seed("B", B, `Bravo${stamp}`);

    // Households both ways: A owns one with B in it, B owns one with A in it,
    // and each has shared their Groceries into the household they are in.
    const aGroup = await admin.sharedGroup.create({ data: { name: `Alpha house ${stamp}`, createdById: A.id } });
    const bGroup = await admin.sharedGroup.create({ data: { name: `Bravo private house ${stamp}`, createdById: B.id } });
    B.group = bGroup.id;
    await admin.groupMember.createMany({
      data: [
        { sharedGroupId: aGroup.id, userId: A.id, role: "OWNER", permission: "WRITE" },
        { sharedGroupId: aGroup.id, userId: B.id, role: "MEMBER", permission: "WRITE" },
        { sharedGroupId: bGroup.id, userId: B.id, role: "OWNER", permission: "WRITE" },
        { sharedGroupId: bGroup.id, userId: A.id, role: "MEMBER", permission: "READ" },
      ],
    });
    await admin.category.update({ where: { id: B.category }, data: { sharedGroupId: aGroup.id } });
    await admin.bankAccount.update({ where: { id: B.account }, data: { sharedGroupId: aGroup.id } });
    await admin.category.update({ where: { id: A.category }, data: { sharedGroupId: bGroup.id } });

    // A's own records that name B.
    await admin.groupInvite.create({
      data: { sharedGroupId: aGroup.id, invitedEmail: B.email, tokenHash: `tok-${stamp}`, permission: "READ", expiresAt: new Date(Date.now() + 86_400_000), createdById: A.id, acceptedById: B.id },
    });
    await admin.auditLog.create({ data: { userId: A.id, entityType: "GroupMember", entityId: B.id, action: "UPDATE", afterData: { permission: "READ" } } });
    await admin.auditLog.create({
      data: { userId: A.id, entityType: "SharedGroup", entityId: aGroup.id, action: "UPDATE", afterData: { newOwnerUserId: B.id, invitedEmail: B.email } },
    });

    // The database's own policies really do let A read B's shared rows: the
    // trap the explicit userId filters exist for.
    const rawA = await admin.$queryRaw<{ v: string }[]>`
      SELECT "description" AS v FROM "NotableTransaction" WHERE "userId" = ${A.id}
      UNION ALL SELECT "last4" FROM "BankAccount" WHERE "userId" = ${A.id}
      UNION ALL SELECT "note" FROM "GoalContribution" WHERE "userId" = ${A.id}
    `;
    aCiphertexts.push(...rawA.map((row) => row.v));
    const rawB = await admin.$queryRaw<{ v: string }[]>`
      SELECT "description" AS v FROM "NotableTransaction" WHERE "userId" = ${B.id}
      UNION ALL SELECT "last4" FROM "BankAccount" WHERE "userId" = ${B.id}
      UNION ALL SELECT "note" FROM "GoalContribution" WHERE "userId" = ${B.id}
      UNION ALL SELECT "totpSecret" FROM "User" WHERE "id" = ${B.id}
      UNION ALL SELECT "topic" FROM "PhoneAlertSubscription" WHERE "userId" = ${B.id}
    `;

    aPlaintext.push(
      A.email,
      `Alpha${stamp} Person`,
      `Alpha${stamp} Bank`,
      "1111",
      `Alpha${stamp} secret purchase memo`,
      `Alpha${stamp} Market`,
      `Alpha${stamp} goal`,
      `Alpha${stamp} legacy note`,
      `Alpha${stamp} notice`,
      `Alpha house ${stamp}`,
      A.transaction,
      A.category,
    );
    bTraces.push(
      B.id,
      B.email,
      `Bravo${stamp}`, // every one of B's texts carries it: name, bank, memo, merchant, goal, note, notice
      "8888",
      `Bravo private house ${stamp}`,
      B.group,
      B.account,
      B.category,
      B.transaction,
      ...rawB.map((row) => row.v),
    );

    const data = await gatherUserExport(A.id);
    if (!data) throw new Error("export returned nothing for A");
    const now = new Date("2026-10-14T12:00:00Z");
    jsonText = new TextDecoder().decode(packageJsonExport(data, now).body);
    csvFiles = Object.fromEntries(Object.entries(unzipSync(packageCsvExport(data, now).body)).map(([name, bytes]) => [name, strFromU8(bytes)]));
    csvText = Object.values(csvFiles).join("\n");
  });

  afterAll(async () => {
    for (const ids of [A, B]) if (ids.id) await deleteAccount(ids.id);
    await admin.accountDeletionRecord.deleteMany({ where: { deletedUserId: { in: [A.id, B.id].filter(Boolean) } } });
    await admin.$disconnect();
  });

  it("really is the trap: under A's own database scope, B's shared rows are readable", async () => {
    const { withUserScope } = await import("../../src/server/db/with-user-scope");
    const visible = await withUserScope(A.id, (tx) => tx.category.findMany({ where: { name: "Groceries" }, select: { userId: true } }));
    expect(visible.map((row) => row.userId).sort()).toEqual([A.id, B.id].sort());
  });

  it("contains every piece of A's decrypted plaintext, in both formats", () => {
    for (const value of aPlaintext) {
      expect(jsonText, `JSON is missing ${value}`).toContain(value);
      expect(csvText, `CSV is missing ${value}`).toContain(value);
    }
  });

  it("holds the decrypted values, never A's stored ciphertext", () => {
    expect(aCiphertexts).toHaveLength(3);
    for (const ciphertext of aCiphertexts) {
      expect(ciphertext).toMatch(/^v[12]:/);
      expect(jsonText).not.toContain(ciphertext);
      expect(csvText).not.toContain(ciphertext);
    }
  });

  it("contains not one byte of B's: no text, id, email or ciphertext, in either format", () => {
    expect(bTraces.length).toBeGreaterThanOrEqual(13);
    for (const trace of bTraces) {
      expect(jsonText.includes(trace), `JSON contains B's ${trace.slice(0, 24)}`).toBe(false);
      expect(csvText.includes(trace), `CSV contains B's ${trace.slice(0, 24)}`).toBe(false);
    }
  });

  it("redacts B where A's own records name B", () => {
    const document = JSON.parse(jsonText);
    const audit = document.tables.auditLog as Array<{ entityType: string; entityId: string; afterData: Record<string, string> }>;
    expect(audit.find((row) => row.entityType === "GroupMember")?.entityId).toBe(REDACTED_PERSON);
    expect(audit.find((row) => row.entityType === "SharedGroup")?.afterData).toEqual({ newOwnerUserId: REDACTED_PERSON, invitedEmail: REDACTED_PERSON });
    expect(document.tables.householdInvitesSent[0].invitedEmail).toBe(REDACTED_PERSON);
    expect(document.tables.householdInvitesSent[0]).not.toHaveProperty("acceptedById");
  });

  it("leaves out A's own credentials", () => {
    const document = JSON.parse(jsonText);
    for (const column of ["passwordHash", "totpSecret", "tokenVersion"]) expect(document.account).not.toHaveProperty(column);
    expect(jsonText).not.toContain(`JBSWY3DPAAAAEHPK3PXP`);
    expect(jsonText).not.toContain(`pfw-export-topic-A-${stamp}`);
    expect(csvText).not.toContain(`pfw-export-topic-A-${stamp}`);
    expect(document.tables.phoneAlertSubscription[0]).not.toHaveProperty("topic");
  });

  it("has exactly A's rows in each table, with money exact", () => {
    const document = JSON.parse(jsonText);
    expect(Object.keys(document.tables)).toEqual([...EXPORT_TABLES]);
    expect(document.tables.categories).toHaveLength(1);
    expect(document.tables.transactions).toEqual([
      expect.objectContaining({ id: A.transaction, userId: A.id, amount: "-12550", nativeAmount: "-12550", occurredAt: SAME_DAY.toISOString() }),
    ]);
    expect(document.tables.householdsCreated.map((row: { name: string }) => row.name)).toEqual([`Alpha house ${stamp}`]);
    // A belongs to two households; the one B owns is named only by the marker.
    const memberships = document.tables.householdMemberships.map((row: { sharedGroupId: string }) => row.sharedGroupId).sort();
    expect(memberships).toEqual([REDACTED_HOUSEHOLD, document.tables.householdsCreated[0].id].sort());
    expect(document.tables.categories[0].sharedGroupId).toBe(REDACTED_HOUSEHOLD);
    for (const name of EXPORT_TABLES) {
      for (const row of document.tables[name] as Array<Record<string, unknown>>) {
        if ("userId" in row) expect(row.userId).toBe(A.id);
      }
    }
  });

  it("packages CSV as a README plus one file per non-empty table", () => {
    expect(csvFiles["README.txt"]).toContain("Rows per table:");
    expect(csvFiles["account.csv"]).toContain(A.email);
    expect(csvFiles["transactions.csv"].split("\r\n")[0]).toContain("description");
    expect(Object.keys(csvFiles)).not.toContain("trades.csv");
  });

  it("returns nothing for a user that does not exist", async () => {
    expect(await gatherUserExport(`missing-${stamp}`)).toBeNull();
  });
});
