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

/** Signed: a positive amount is a contribution, negative is a withdrawal (schema.prisma's GoalContribution comment). Returns `null` if the goal isn't the caller's. */
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
