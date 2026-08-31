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

export type ZkNoteCiphertext = { id: string; note: string };

/**
 * Every `GoalContribution.note` already in the CURRENT "zk1:..." format
 * — opaque ciphertext blobs only, the server never decrypts any of them
 * here. This is the read half of Passphrase Rotation (AGENTS.md §3m
 * amendment): the client fetches these, decrypts each one client-side
 * with the OLD key (inside the Web Worker, `zkVaultRotate` /
 * `createZkCryptoHandlers`'s `rotate` handler), re-encrypts under the
 * NEW key, and sends the result back to `rotateZkVaultPassphrase` below.
 * Deliberately excludes any note still in the OLD server-side "v1:..."
 * format — that's `findLegacyNoteContributions`'s own, separate,
 * one-time migration path, unaffected by rotating an ALREADY-zero-
 * knowledge vault's passphrase.
 */
export async function listZkNoteCiphertexts(userId: string): Promise<ZkNoteCiphertext[]> {
  const rows = await withUserScope(userId, (tx) =>
    tx.goalContribution.findMany({
      where: { userId, note: { not: null } },
      select: { id: true, note: true },
    }),
  );

  return rows
    .filter((row): row is typeof row & { note: string } => row.note !== null && row.note.startsWith("zk1:"))
    .map((row) => ({ id: row.id, note: row.note }));
}

export type RotateZkVaultPassphraseInput = {
  newSalt: string;
  newIterations: number;
  newCanaryCiphertext: string;
  /** Every currently-"zk1:"-formatted note, re-encrypted under the new key — must be an EXACT match (same id set) against `listZkNoteCiphertexts`'s current result, checked again inside this function's own transaction. */
  reencryptedNotes: ZkNoteCiphertext[];
};

export type RotateZkVaultPassphraseResult =
  | { ok: true }
  | { ok: false; error: "not_set_up" | "notes_changed_concurrently" };

/**
 * Passphrase Rotation (AGENTS.md §3m amendment): atomically overwrites
 * `User.zkSalt`/`zkKdfIterations`/`zkCanaryCiphertext` AND every
 * `GoalContribution.note` this rotation covers, in the SAME
 * `withUserScope` transaction (a single real Postgres transaction — see
 * `with-user-scope.ts`) — this is the "persist the updated ciphertext
 * and salt in a single atomic transaction" requirement: a rotation that
 * updated the salt but only SOME notes (a crash mid-write, a network
 * drop) would otherwise leave the un-migrated notes permanently
 * undecryptable, since the old salt is gone the moment this commits.
 *
 * Re-fetches the current "zk1:" note id set INSIDE the transaction and
 * requires it to EXACTLY match `input.reencryptedNotes`'s id set before
 * writing anything — a note added/edited between the client's read
 * (`listZkNoteCiphertexts`) and this write (e.g. a second browser tab)
 * would otherwise either get silently dropped (permanently orphaned
 * under the vanishing old salt) or have a stale re-encryption overwrite
 * a newer edit. Failing closed here (rather than writing a partial/
 * stale result) is the correct behavior — the caller should re-fetch and
 * retry the whole rotation from scratch.
 */
export async function rotateZkVaultPassphrase(
  userId: string,
  input: RotateZkVaultPassphraseInput,
): Promise<RotateZkVaultPassphraseResult> {
  return withUserScope(userId, async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { zkSalt: true } });
    if (user?.zkSalt == null) return { ok: false, error: "not_set_up" };

    const currentRows = await tx.goalContribution.findMany({
      where: { userId, note: { not: null } },
      select: { id: true, note: true },
    });
    const currentZkNoteIds = new Set(
      currentRows.filter((row) => row.note !== null && row.note.startsWith("zk1:")).map((row) => row.id),
    );
    const submittedIds = new Set(input.reencryptedNotes.map((note) => note.id));
    const idsMatch =
      currentZkNoteIds.size === submittedIds.size && [...currentZkNoteIds].every((id) => submittedIds.has(id));
    if (!idsMatch) return { ok: false, error: "notes_changed_concurrently" };

    await tx.user.update({
      where: { id: userId },
      data: { zkSalt: input.newSalt, zkKdfIterations: input.newIterations, zkCanaryCiphertext: input.newCanaryCiphertext },
    });

    for (const note of input.reencryptedNotes) {
      await tx.goalContribution.update({ where: { id: note.id }, data: { note: note.note } });
    }

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
