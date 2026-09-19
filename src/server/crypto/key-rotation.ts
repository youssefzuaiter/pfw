import "server-only";
import { createAdminClient } from "../db/admin-client";
import { getEncryptionKeyNext } from "../env";
import { decryptField, encryptField, getActiveEncryptionKeyId } from "./field-encryption";

/**
 * `ENCRYPTION_KEY` rotation, part 2 of 2 (`field-encryption.ts` is part
 * 1 — it defines the `v1:`/`v2:<key id>:` format this module moves rows
 * between). Closes `docs/SECURITY-CHECKLIST.md`'s "Secret rotation &
 * storage guidelines" entry for `ENCRYPTION_KEY`, previously documented
 * there as the one genuinely hard rotation and explicitly "not built
 * yet" — this is that build.
 *
 * A NO-OP by construction whenever `ENCRYPTION_KEY_NEXT` is unset (the
 * ordinary, non-rotating state of every deployment almost all the time):
 * `runEncryptionKeyRotationSweep()` returns immediately with zero
 * database access, so running this nightly via `GET /api/cron` alongside
 * this app's other batch jobs (FX/crypto/equity-quote sync, the Dead
 * Man's Switch check) costs nothing on every ordinary night.
 *
 * THE ADMIN-CLIENT EXCEPTION, same shape as three prior ones (see
 * tests/guards/admin-client-boundary.test.ts's own comment for the
 * full list): a rotation has to touch EVERY user's encrypted rows in one
 * pass, with no single `userId` to scope a `withUserScope` transaction
 * by — exactly `inactivity-check.ts`'s and `quote-sync.ts`'s shape,
 * applied here to "which rows still carry ciphertext under the OLD key"
 * instead of "which switches have gone stale" or "which symbols does
 * anyone hold."
 *
 * SIX PLACES THIS APP STORES CIPHERTEXT, all six covered:
 *
 *   - Four columns the `encrypted-fields.ts` Prisma Client extension
 *     already manages transparently (`BankAccount.last4`,
 *     `NotableTransaction.description`, `User.totpSecret`,
 *     `BankConnection.accessToken`) — for these, re-keying is nothing
 *     more than a plain READ-THEN-WRITE-BACK round trip: the extension
 *     decrypts on read (using whichever key `field-encryption.ts` says
 *     the row's own format/key-id calls for) and re-encrypts on write
 *     (always onto `ENCRYPTION_KEY_NEXT`, since `encryptField()` already
 *     prefers it whenever it's set) — no manual `encryptField`/
 *     `decryptField` call needed here at all for these four. Every raw
 *     SQL statement below is a literal, hardcoded string with the table
 *     and column names written directly into it (never built from a
 *     variable) — only the search prefix and row-count LIMIT are
 *     interpolated, and Prisma's tagged-template `$queryRaw` binds those
 *     as real parameters, never string-concatenates them — used ONLY to
 *     find which row ids still need touching, since the extension never
 *     exposes raw ciphertext through its normal query API to test a
 *     prefix against (the identical reason `searchTransactionsSemantic`
 *     reaches for `$queryRaw` at all, AGENTS.md §3cc). The actual
 *     re-encryption goes back through the ordinary, extension-wrapped
 *     `findUnique`/`update`.
 *   - Two places that deliberately sit OUTSIDE that extension and always
 *     have (`RecoveryShareSubmission.shareValueCiphertext`, written via
 *     `encryptField`/`decryptField` directly by
 *     `dead-mans-switch/recovery-service.ts`; and any surviving
 *     PRE-zero-knowledge `GoalContribution.note` row — one still in the
 *     old `v1:`/`v2:` server-held format because its user never ran
 *     `POST /api/zk/migrate-legacy`, AGENTS.md §3m) — for these, a plain
 *     Prisma read already returns the raw stored string (nothing
 *     auto-decrypts it), so this module calls `decryptField`/
 *     `encryptField` itself, exactly as those two call sites already do,
 *     with no raw SQL needed at all. A genuine zero-knowledge note
 *     (`zk1:`-prefixed) is never touched — it is, by design, the one
 *     thing on this list this module (and the server generally) can
 *     never decrypt in the first place.
 *
 * Never throws: one row's re-encryption failing (a transient DB error,
 * say) is logged and counted, not fatal to the whole sweep — the same
 * "one bad row doesn't abort the batch" discipline
 * `scripts/backfill-embeddings.ts` already applies. A capped number of
 * rows is touched per table per run (`MAX_ROWS_PER_TABLE_PER_RUN`) —
 * generous for this app's real personal-ledger scale, but a real,
 * deliberate bound rather than unbounded work inside one request/cron
 * invocation; `remaining` is always an honest, uncapped count, so a
 * rotation spanning more rows than one run's cap simply finishes over
 * the next several nightly runs, converging to zero on its own.
 */

const MAX_ROWS_PER_TABLE_PER_RUN = 500;

export type KeyRotationSweepResult =
  | { ok: true; inProgress: false }
  | { ok: true; inProgress: true; reencrypted: number; remaining: number; failed: number }
  | { ok: false; inProgress: true; error: string };

export type AdminClient = ReturnType<typeof createAdminClient>;
type Tally = { reencrypted: number; failed: number; remaining: number };

function addTally(a: Tally, b: Tally): Tally {
  return {
    reencrypted: a.reencrypted + b.reencrypted,
    failed: a.failed + b.failed,
    remaining: a.remaining + b.remaining,
  };
}

/** Runs `readAndWriteBack` for each stale id, tallying successes/failures; never throws itself. */
async function touchRows(
  label: string,
  ids: string[],
  readAndWriteBack: (id: string) => Promise<void>,
): Promise<{ reencrypted: number; failed: number }> {
  let reencrypted = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      await readAndWriteBack(id);
      reencrypted++;
    } catch (error) {
      failed++;
      console.error(`key-rotation: FAILED re-encrypting ${label} id=${id}: ${(error as Error).message}`);
    }
  }
  return { reencrypted, failed };
}

export async function sweepBankAccountLast4(admin: AdminClient, prefix: string): Promise<Tally> {
  const stale = await admin.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "BankAccount" WHERE "last4" IS NOT NULL AND "last4" NOT LIKE ${`${prefix}%`}
    LIMIT ${MAX_ROWS_PER_TABLE_PER_RUN}
  `;
  const { reencrypted, failed } = await touchRows("BankAccount.last4", stale.map((r) => r.id), async (id) => {
    const row = await admin.bankAccount.findUniqueOrThrow({ where: { id }, select: { last4: true } });
    await admin.bankAccount.update({ where: { id }, data: { last4: row.last4 } });
  });
  const [{ count }] = await admin.$queryRaw<{ count: bigint }[]>`
    SELECT count(*)::bigint AS count FROM "BankAccount" WHERE "last4" IS NOT NULL AND "last4" NOT LIKE ${`${prefix}%`}
  `;
  return { reencrypted, failed, remaining: Number(count) };
}

export async function sweepTransactionDescription(admin: AdminClient, prefix: string): Promise<Tally> {
  const stale = await admin.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "NotableTransaction" WHERE "description" IS NOT NULL AND "description" NOT LIKE ${`${prefix}%`}
    LIMIT ${MAX_ROWS_PER_TABLE_PER_RUN}
  `;
  const { reencrypted, failed } = await touchRows("NotableTransaction.description", stale.map((r) => r.id), async (id) => {
    const row = await admin.notableTransaction.findUniqueOrThrow({ where: { id }, select: { description: true } });
    await admin.notableTransaction.update({ where: { id }, data: { description: row.description } });
  });
  const [{ count }] = await admin.$queryRaw<{ count: bigint }[]>`
    SELECT count(*)::bigint AS count FROM "NotableTransaction"
    WHERE "description" IS NOT NULL AND "description" NOT LIKE ${`${prefix}%`}
  `;
  return { reencrypted, failed, remaining: Number(count) };
}

export async function sweepUserTotpSecret(admin: AdminClient, prefix: string): Promise<Tally> {
  const stale = await admin.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "User" WHERE "totpSecret" IS NOT NULL AND "totpSecret" NOT LIKE ${`${prefix}%`}
    LIMIT ${MAX_ROWS_PER_TABLE_PER_RUN}
  `;
  const { reencrypted, failed } = await touchRows("User.totpSecret", stale.map((r) => r.id), async (id) => {
    const row = await admin.user.findUniqueOrThrow({ where: { id }, select: { totpSecret: true } });
    // totpSecret is nullable — the raw-SQL scan above already excluded
    // NULLs, but the generated type doesn't know that from a plain
    // findUniqueOrThrow, so this satisfies TypeScript without weakening
    // the actual query.
    if (row.totpSecret === null) return;
    await admin.user.update({ where: { id }, data: { totpSecret: row.totpSecret } });
  });
  const [{ count }] = await admin.$queryRaw<{ count: bigint }[]>`
    SELECT count(*)::bigint AS count FROM "User" WHERE "totpSecret" IS NOT NULL AND "totpSecret" NOT LIKE ${`${prefix}%`}
  `;
  return { reencrypted, failed, remaining: Number(count) };
}

export async function sweepBankConnectionAccessToken(admin: AdminClient, prefix: string): Promise<Tally> {
  const stale = await admin.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "BankConnection" WHERE "accessToken" IS NOT NULL AND "accessToken" NOT LIKE ${`${prefix}%`}
    LIMIT ${MAX_ROWS_PER_TABLE_PER_RUN}
  `;
  const { reencrypted, failed } = await touchRows("BankConnection.accessToken", stale.map((r) => r.id), async (id) => {
    const row = await admin.bankConnection.findUniqueOrThrow({ where: { id }, select: { accessToken: true } });
    await admin.bankConnection.update({ where: { id }, data: { accessToken: row.accessToken } });
  });
  const [{ count }] = await admin.$queryRaw<{ count: bigint }[]>`
    SELECT count(*)::bigint AS count FROM "BankConnection"
    WHERE "accessToken" IS NOT NULL AND "accessToken" NOT LIKE ${`${prefix}%`}
  `;
  return { reencrypted, failed, remaining: Number(count) };
}

/**
 * `RecoveryShareSubmission.shareValueCiphertext` sits outside the
 * extension (`dead-mans-switch/recovery-service.ts` calls `encryptField`/
 * `decryptField` directly) — a plain Prisma read already returns the raw
 * stored string, so no raw-SQL prefix scan is needed here at all; the JS
 * prefix check does the same job on the value already in hand.
 */
export async function sweepRecoveryShareSubmissions(admin: AdminClient, prefix: string): Promise<Tally> {
  const rows = await admin.recoveryShareSubmission.findMany({ select: { id: true, shareValueCiphertext: true } });
  const stale = rows.filter((row) => !row.shareValueCiphertext.startsWith(prefix));

  const { reencrypted, failed } = await touchRows(
    "RecoveryShareSubmission.shareValueCiphertext",
    stale.slice(0, MAX_ROWS_PER_TABLE_PER_RUN).map((row) => row.id),
    async (id) => {
      const row = stale.find((r) => r.id === id);
      /* c8 ignore next -- unreachable: id came from `stale` itself, just above. */
      if (!row) return;
      const plaintext = decryptField(row.shareValueCiphertext);
      await admin.recoveryShareSubmission.update({ where: { id }, data: { shareValueCiphertext: encryptField(plaintext) } });
    },
  );

  return { reencrypted, failed, remaining: stale.length - reencrypted };
}

/**
 * Legacy (pre-zero-knowledge, AGENTS.md §3m) `GoalContribution.note`
 * rows only — a real `zk1:`-prefixed note is never read, decrypted, or
 * touched here: the server cannot decrypt it and must not try, rotation
 * or not. This is the exact same filter `findLegacyNoteContributions`
 * already uses for its own one-time migration path — kept independent
 * here rather than imported, since that function's job (return
 * plaintext to a caller) and this one's (re-encrypt in place) are
 * genuinely different operations that happen to share a predicate.
 */
export async function sweepLegacyGoalContributionNotes(admin: AdminClient, prefix: string): Promise<Tally> {
  const rows = await admin.goalContribution.findMany({
    where: { note: { not: null } },
    select: { id: true, note: true },
  });
  const legacy = rows.filter(
    (row): row is typeof row & { note: string } => row.note !== null && !row.note.startsWith("zk1:"),
  );
  const stale = legacy.filter((row) => !row.note.startsWith(prefix));

  const { reencrypted, failed } = await touchRows(
    "GoalContribution.note",
    stale.slice(0, MAX_ROWS_PER_TABLE_PER_RUN).map((row) => row.id),
    async (id) => {
      const row = stale.find((r) => r.id === id);
      /* c8 ignore next -- unreachable: id came from `stale` itself, just above. */
      if (!row) return;
      const plaintext = decryptField(row.note);
      await admin.goalContribution.update({ where: { id }, data: { note: encryptField(plaintext) } });
    },
  );

  return { reencrypted, failed, remaining: stale.length - reencrypted };
}

export async function runEncryptionKeyRotationSweep(): Promise<KeyRotationSweepResult> {
  if (!getEncryptionKeyNext()) return { ok: true, inProgress: false };

  const newKeyId = getActiveEncryptionKeyId();
  /* c8 ignore next -- unreachable: getEncryptionKeyNext() just returned non-null above, so this can't be null. */
  if (!newKeyId) return { ok: true, inProgress: false };
  const prefix = `v2:${newKeyId}:`;

  const admin = createAdminClient();
  try {
    let tally: Tally = { reencrypted: 0, failed: 0, remaining: 0 };
    tally = addTally(tally, await sweepBankAccountLast4(admin, prefix));
    tally = addTally(tally, await sweepTransactionDescription(admin, prefix));
    tally = addTally(tally, await sweepUserTotpSecret(admin, prefix));
    tally = addTally(tally, await sweepBankConnectionAccessToken(admin, prefix));
    tally = addTally(tally, await sweepRecoveryShareSubmissions(admin, prefix));
    tally = addTally(tally, await sweepLegacyGoalContributionNotes(admin, prefix));

    // `ok: true` here means "the sweep itself ran to completion," not
    // "every row succeeded" — matching this app's existing sync-job
    // convention (`syncCryptoPrices`'s own `skipped` list, say): a
    // per-row failure is retryable (next night's run picks the same
    // still-stale row back up, since it never moved onto the new key's
    // prefix) and is reported via `failed`/`remaining`, not treated as a
    // whole-job failure. `runEncryptionKeyRotationSweep` only ever
    // returns `ok: false` when the sweep couldn't run AT ALL (the catch
    // block below) — the caller (`/api/cron`) is what decides whether a
    // nonzero `failed` count is itself worth an operator alert.
    return {
      ok: true,
      inProgress: true,
      reencrypted: tally.reencrypted,
      remaining: tally.remaining,
      failed: tally.failed,
    };
  } catch (error) {
    return { ok: false, inProgress: true, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await admin.$disconnect();
  }
}
