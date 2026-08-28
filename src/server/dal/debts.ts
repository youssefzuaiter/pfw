import "server-only";
import { accrueInterest, bps } from "../../lib/apr";
import { agorot, subtractAgorot } from "../../lib/money";
import { withUserScope } from "../db/with-user-scope";
import type { Prisma } from "../../generated/prisma/client";

/** See bank-accounts.ts for why this returns `null` rather than throwing on a mismatch. */
export async function getDebtById(userId: string, id: string) {
  return withUserScope(userId, (tx) =>
    tx.debt.findFirst({ where: { id, userId }, include: { payments: { orderBy: { paidAt: "desc" } } } }),
  );
}

export async function listDebts(userId: string) {
  return withUserScope(userId, (tx) =>
    tx.debt.findMany({
      where: { userId },
      include: { payments: { orderBy: { paidAt: "desc" } } },
      orderBy: { createdAt: "asc" },
    }),
  );
}

export async function createDebt(
  userId: string,
  input: {
    name: string;
    debtType: Prisma.DebtCreateInput["debtType"];
    currentBalance: bigint;
    aprBps: number;
    minimumPayment: bigint;
  },
) {
  return withUserScope(userId, (tx) => tx.debt.create({ data: { userId, ...input } }));
}

export type RecordDebtPaymentResult = Awaited<ReturnType<typeof getDebtById>>;

/**
 * Splits the payment into principal/interest using the same closed-form
 * accrual as the debt-math engine (src/lib/apr.ts's `accrueInterest`),
 * then reduces (or, under sustained negative amortization, increases)
 * the debt's stored `currentBalance` accordingly — the same mechanic
 * `buildAmortizationSchedule` models for a *projected* schedule, applied
 * here to a real recorded payment.
 */
export async function recordDebtPayment(
  userId: string,
  debtId: string,
  input: { amount: bigint; paidAt: Date },
): Promise<RecordDebtPaymentResult> {
  return withUserScope(userId, async (tx) => {
    const debt = await tx.debt.findFirst({ where: { id: debtId, userId } });
    if (!debt) return null;

    const balance = agorot(Number(debt.currentBalance));
    const payment = agorot(Number(input.amount));
    const interest = accrueInterest(balance, bps(debt.aprBps));

    let principalPortion: bigint;
    let newBalance: bigint;
    if (payment >= interest) {
      const principal = subtractAgorot(payment, interest);
      principalPortion = BigInt(principal);
      newBalance = principal > balance ? 0n : BigInt(subtractAgorot(balance, principal));
    } else {
      // Negative amortization: unpaid interest capitalizes onto the balance.
      const shortfall = subtractAgorot(interest, payment);
      principalPortion = -BigInt(shortfall);
      newBalance = debt.currentBalance + BigInt(shortfall);
    }

    await tx.debtPayment.create({
      data: {
        userId,
        debtId,
        amount: input.amount,
        paidAt: input.paidAt,
        principalPortion,
        interestPortion: BigInt(interest),
      },
    });

    await tx.debt.update({ where: { id: debtId }, data: { currentBalance: newBalance } });

    return tx.debt.findFirst({ where: { id: debtId, userId }, include: { payments: { orderBy: { paidAt: "desc" } } } });
  });
}
