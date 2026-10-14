import "server-only";
import { createAdminClient } from "../db/admin-client";

/**
 * Encrypts `BankConnection.accessToken` values that were stored as
 * plaintext (AGENTS.md §3rrr), nightly from GET /api/cron.
 *
 * Until the extension was actually registered for `bankConnection`, every
 * token went into the database as written. New rows are ciphertext now; this
 * finds the old ones by what they LACK, a `v1:`/`v2:` prefix, and rewrites
 * each through the extension: the tolerant read returns the plaintext, the
 * write encrypts it. Idempotent, and a cheap no-op (one SELECT) once nothing
 * is left, so it can stay in the cron.
 *
 * An admin-client exception (allowlisted), the key-rotation sweep's shape:
 * rows of every user, no session, no single userId. Unlike that sweep it is
 * safe to run for real in the shared test database: it only ever touches a
 * value with no prefix, which nothing but a deliberately raw insert can
 * produce, so it cannot reach another test file's rows.
 *
 * Never throws; one row failing is counted and retried the next night.
 */
const MAX_ROWS_PER_RUN = 500;

export type LegacyPlaintextSweepResult =
  | { ok: true; encrypted: number; failed: number; remaining: number }
  | { ok: false; error: string };

export async function encryptLegacyPlaintextBankTokens(): Promise<LegacyPlaintextSweepResult> {
  const admin = createAdminClient();
  try {
    const legacy = await admin.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "BankConnection"
      WHERE "accessToken" NOT LIKE 'v1:%' AND "accessToken" NOT LIKE 'v2:%'
      LIMIT ${MAX_ROWS_PER_RUN}
    `;

    let encrypted = 0;
    let failed = 0;
    for (const { id } of legacy) {
      try {
        const row = await admin.bankConnection.findUniqueOrThrow({ where: { id }, select: { accessToken: true } });
        await admin.bankConnection.update({ where: { id }, data: { accessToken: row.accessToken } });
        encrypted++;
      } catch (error) {
        failed++;
        console.error(`legacy-plaintext-sweep: FAILED encrypting BankConnection id=${id}: ${(error as Error).message}`);
      }
    }

    const [{ count }] = await admin.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM "BankConnection"
      WHERE "accessToken" NOT LIKE 'v1:%' AND "accessToken" NOT LIKE 'v2:%'
    `;
    return { ok: true, encrypted, failed, remaining: Number(count) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await admin.$disconnect();
  }
}
