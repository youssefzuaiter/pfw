import "server-only";
import { decryptField } from "../crypto/field-encryption";
import { withUserScope } from "../db/with-user-scope";

/**
 * DAL for the per-user zero-knowledge vault backing `GoalContribution.note`
 * (AGENTS.md §3m). Every value read/written here — salt, iteration count,
 * canary ciphertext, note ciphertext — is either non-secret or already
 * client-encrypted; nothing in this file ever sees a passphrase or a
 * decrypted note, EXCEPT `findLegacyNoteContributions`, whose entire job
 * is the one deliberate, one-time exception — see its own doc comment.
 */

export type ZkVaultStatus = {
  isSetUp: boolean;
  salt: string | null;
  iterations: number | null;
  canaryCiphertext: string | null;
};

export async function getZkVaultStatus(userId: string): Promise<ZkVaultStatus> {
  const user = await withUserScope(userId, (tx) =>
    tx.user.findUnique({
      where: { id: userId },
      select: { zkSalt: true, zkKdfIterations: true, zkCanaryCiphertext: true },
    }),
  );

  return {
    isSetUp: user?.zkSalt != null,
    salt: user?.zkSalt ?? null,
    iterations: user?.zkKdfIterations ?? null,
    canaryCiphertext: user?.zkCanaryCiphertext ?? null,
  };
}

export type SetupZkVaultInput = { salt: string; iterations: number; canaryCiphertext: string };
export type SetupZkVaultResult = { ok: true } | { ok: false; error: "already_set_up" };

/**
 * One-time only. This app has no passphrase-rotation/re-key flow: once
 * `zkSalt` is set, every note encrypted under it becomes permanently
 * undecryptable the moment the salt or iteration count changed under it,
 * so overwriting an existing setup would silently orphan every note
 * already encrypted under the old one — same failure shape
 * `docs/SECURITY-CHECKLIST.md`'s `ENCRYPTION_KEY` rotation note describes
 * for the server-side codec, just one layer down. A real "change my
 * passphrase" feature would need to re-encrypt every existing note under
 * the new key first (decrypt-with-old, re-encrypt-with-new, all
 * client-side) before this row is allowed to change — not built here.
 */
export async function setupZkVault(userId: string, input: SetupZkVaultInput): Promise<SetupZkVaultResult> {
  return withUserScope(userId, async (tx) => {
    const existing = await tx.user.findUnique({ where: { id: userId }, select: { zkSalt: true } });
    if (existing?.zkSalt != null) return { ok: false, error: "already_set_up" };

    await tx.user.update({
      where: { id: userId },
      data: { zkSalt: input.salt, zkKdfIterations: input.iterations, zkCanaryCiphertext: input.canaryCiphertext },
    });
    return { ok: true };
  });
}

export type LegacyNoteContribution = { id: string; goalId: string; plaintext: string };

/**
 * The one deliberate, one-time server-side plaintext exposure in this
 * whole feature: a `GoalContribution.note` written before the zero-
 * knowledge vault existed is ciphertext under the OLD server-held
 * `ENCRYPTION_KEY` (`src/server/crypto/field-encryption.ts`'s "v1:..."
 * format) — the server is the only party that can ever decrypt it, so
 * migrating it into a scheme the server can never decrypt necessarily
 * means the server decrypts it exactly once, on the way out, so the
 * client can immediately re-encrypt it under the new zero-knowledge key.
 * This mirrors how any real end-to-end-encryption migration works (e.g.
 * re-keying a password-manager vault) — there is no way to hand off
 * custody of already-server-encrypted data to a client-only key without
 * one such handoff moment. What must never happen: this plaintext being
 * logged, cached, or persisted anywhere beyond this one response — see
 * the route handler for the matching "never log the body" discipline.
 *
 * Only ever called from `POST /api/zk/migrate-legacy`, itself only
 * reachable by the authenticated owner (guardMutation + this function's
 * own `userId` scoping), so this isn't a new authorization hole — it's a
 * deliberately-scoped, one-time transition path.
 */
export async function findLegacyNoteContributions(userId: string): Promise<LegacyNoteContribution[]> {
  const rows = await withUserScope(userId, (tx) =>
    tx.goalContribution.findMany({
      where: { userId, note: { not: null } },
      select: { id: true, goalId: true, note: true },
    }),
  );

  return rows
    .filter((row): row is typeof row & { note: string } => row.note !== null && !row.note.startsWith("zk1:"))
    .map((row) => ({ id: row.id, goalId: row.goalId, plaintext: decryptField(row.note) }));
}
