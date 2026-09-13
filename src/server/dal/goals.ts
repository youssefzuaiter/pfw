import "server-only";
import { withUserScope } from "../db/with-user-scope";

/** See bank-accounts.ts for why this returns `null` rather than throwing on a mismatch. */
export async function getGoalById(userId: string, id: string) {
  return withUserScope(userId, (tx) =>
    tx.goal.findFirst({ where: { id, userId }, include: { contributions: true } }),
  );
}

/** Includes contributions — callers derive `currentAmount` by summing them (the "derived truth" law; progress is never stored). */
export async function listGoals(userId: string) {
  return withUserScope(userId, (tx) =>
    tx.goal.findMany({ where: { userId }, include: { contributions: true }, orderBy: { createdAt: "asc" } }),
  );
}

export async function createGoal(userId: string, input: { name: string; targetAmount: bigint; targetDate?: Date }) {
  return withUserScope(userId, (tx) =>
    tx.goal.create({
      data: { userId, name: input.name, targetAmount: input.targetAmount, targetDate: input.targetDate },
    }),
  );
}

/**
 * Signed: a positive amount is a contribution, negative is a withdrawal
 * (schema.prisma's GoalContribution comment). Returns `null` if the goal
 * isn't the caller's. `note`, if present, is already zero-knowledge
 * ciphertext by the time it reaches this function — the route layer
 * validates its "zk1:..." shape before calling this (AGENTS.md §3m); this
 * DAL function just persists whatever string it's given, same as every
 * other field, now that GoalContribution.note has left the server-side
 * field-encryption extension.
 */
export async function addGoalContribution(
  userId: string,
  goalId: string,
  input: { amount: bigint; contributedAt: Date; note?: string },
) {
  return withUserScope(userId, async (tx) => {
    const goal = await tx.goal.findFirst({ where: { id: goalId, userId } });
    if (!goal) return null;

    return tx.goalContribution.create({
      data: { userId, goalId, amount: input.amount, contributedAt: input.contributedAt, note: input.note },
    });
  });
}

export type DeleteGoalResult = { ok: true; name: string } | { ok: false; error: "not_found" };

/**
 * Hard delete — removes the goal and, via `GoalContribution.goal`'s
 * `onDelete: Cascade` (schema.prisma), every one of its contributions
 * with it. Returns `{ ok: false, error: "not_found" }` for both a
 * nonexistent goal and one belonging to someone else (IDOR-safe, same
 * convention as `getGoalById`/`deleteCryptoWallet`).
 */
export async function deleteGoal(userId: string, goalId: string): Promise<DeleteGoalResult> {
  return withUserScope(userId, async (tx) => {
    const existing = await tx.goal.findFirst({ where: { id: goalId, userId } });
    if (!existing) return { ok: false, error: "not_found" };

    await tx.goal.delete({ where: { id: goalId } });
    return { ok: true, name: existing.name };
  });
}

/**
 * Overwrites one contribution's note with a new zero-knowledge ciphertext
 * blob — used by the vault-setup migration flow to re-encrypt a legacy
 * ("v1:...") note under the user's new zero-knowledge key, and by ordinary
 * note edits thereafter. Returns `null` if the contribution isn't the
 * caller's (IDOR-safe, same convention as `getGoalById`).
 */
export async function updateGoalContributionNote(userId: string, contributionId: string, noteCiphertext: string) {
  return withUserScope(userId, async (tx) => {
    const existing = await tx.goalContribution.findFirst({ where: { id: contributionId, userId } });
    if (!existing) return null;

    return tx.goalContribution.update({ where: { id: contributionId }, data: { note: noteCiphertext } });
  });
}
