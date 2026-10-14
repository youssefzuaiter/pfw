import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import { getBankConnectionForSync, linkBankConnection, listBankConnections } from "../../src/server/dal/bank-connections";
import { encryptLegacyPlaintextBankTokens } from "../../src/server/crypto/legacy-plaintext-sweep";
import { MOCK_INSTITUTIONS } from "../../src/lib/banking/psd2-client";

/**
 * BankConnection.accessToken at rest (AGENTS.md §3rrr), against real
 * Postgres with RLS. The token was listed as encrypted from the start but the
 * extension was never registered for the model, so every token was stored as
 * written. Raw SQL is the only way to see what is actually stored: the admin
 * client carries the same extension and decrypts on read.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("bank connection access token at rest", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let user: { id: string };

  const institution = MOCK_INSTITUTIONS[0];
  const LEGACY_TOKEN = "mock_psd2_legacy_plaintext_token_0001";

  async function stored(connectionId: string): Promise<string> {
    const [row] = await admin.$queryRaw<{ accessToken: string }[]>`SELECT "accessToken" FROM "BankConnection" WHERE "id" = ${connectionId}`;
    return row.accessToken;
  }

  /** A connection whose token is stored as plaintext, the way every row was before the fix. */
  async function insertLegacyConnection(token: string): Promise<string> {
    const account = await admin.bankAccount.create({
      data: { userId: user.id, institutionName: "Legacy Bank", last4: "9999", accountType: "CHECKING", nativeBalance: 0n },
    });
    const id = `legacy_${Math.random().toString(36).slice(2, 12)}`;
    await admin.$executeRaw`
      INSERT INTO "BankConnection" ("id", "userId", "institutionId", "bankAccountId", "accessToken", "expiresAt")
      VALUES (${id}, ${user.id}, ${institution.id}, ${account.id}, ${token}, now() + interval '90 days')
    `;
    return id;
  }

  beforeAll(async () => {
    admin = createAdminClient();
    user = await admin.user.create({ data: { email: `bank-token-${Date.now()}@pfw.local`, displayName: "Bank Token" } });
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { id: user.id } });
    await admin.$disconnect();
  });

  it("stores a new connection's token as ciphertext and reads it back as the token", async () => {
    const token = "mock_psd2_new_connection_token_0001";
    const connection = await linkBankConnection(user.id, institution.id, {
      accessToken: token,
      expiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000),
      account: { iban: "DE00000000000000009999" },
    } as never);

    const raw = await stored(connection.id);
    expect(raw).toMatch(/^v[12]:/);
    expect(raw).not.toContain(token);
    expect((await getBankConnectionForSync(user.id, connection.id))?.accessToken).toBe(token);
  });

  it("still reads a token stored as plaintext before the fix, instead of throwing", async () => {
    const id = await insertLegacyConnection(LEGACY_TOKEN);
    expect(await stored(id)).toBe(LEGACY_TOKEN);

    expect((await getBankConnectionForSync(user.id, id))?.accessToken).toBe(LEGACY_TOKEN);
    expect((await listBankConnections(user.id)).some((c) => c.id === id)).toBe(true);
  });

  it("encrypts every plaintext token, leaves encrypted ones alone, and is idempotent", async () => {
    const id = await insertLegacyConnection("mock_psd2_second_legacy_token_0002");
    const existing = await admin.bankConnection.findMany({ where: { userId: user.id }, select: { id: true } });
    const before = new Map(await Promise.all(existing.map(async (c) => [c.id, await stored(c.id)] as const)));
    const encryptedBefore = [...before].filter(([, raw]) => /^v[12]:/.test(raw));
    expect(encryptedBefore.length).toBeGreaterThan(0);

    const first = await encryptLegacyPlaintextBankTokens();
    expect(first).toMatchObject({ ok: true, failed: 0, remaining: 0 });
    if (first.ok) expect(first.encrypted).toBeGreaterThanOrEqual(2);

    for (const [connectionId, raw] of before) {
      const now = await stored(connectionId);
      if (/^v[12]:/.test(raw)) expect(now).toBe(raw); // untouched: not even re-encrypted
      else {
        expect(now).toMatch(/^v[12]:/);
        expect(now).not.toContain(raw);
      }
    }
    expect((await getBankConnectionForSync(user.id, id))?.accessToken).toBe("mock_psd2_second_legacy_token_0002");

    const second = await encryptLegacyPlaintextBankTokens();
    expect(second).toEqual({ ok: true, encrypted: 0, failed: 0, remaining: 0 });
  });
});
