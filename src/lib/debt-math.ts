import { type Agorot, addAgorot, agorot, multiplyAgorot, subtractAgorot } from "./money";
import { type BasisPoints, accrueInterest, annualBpsToMonthlyRate } from "./apr";

/** Hard safety cap on simulated months — 50 years — so a pathological input (e.g. a payment that never covers interest) can't loop forever. */
const MAX_SIMULATED_MONTHS = 600;

export type AmortizationScheduleEntry = {
  month: number;
  payment: Agorot;
  /** Negative when this month's payment doesn't cover interest — the balance grew (negative amortization). */
  principalPortion: Agorot;
  interestPortion: Agorot;
  remainingBalance: Agorot;
};

/**
 * The closed-form fixed monthly payment for a fully amortizing loan:
 * M = P * r(1+r)^n / ((1+r)^n - 1), where r is the monthly periodic rate.
 * Degenerates to a plain P/n split at 0% APR (the formula above divides
 * by zero there).
 */
export function calculateMonthlyPayment(principal: Agorot, aprBps: BasisPoints, termMonths: number): Agorot {
  if (!Number.isInteger(termMonths) || termMonths <= 0) {
    throw new RangeError(`termMonths must be a positive integer, received ${termMonths}`);
  }

  const monthlyRate = annualBpsToMonthlyRate(aprBps);
  if (monthlyRate === 0) {
    return multiplyAgorot(principal, 1 / termMonths);
  }

  const growth = Math.pow(1 + monthlyRate, termMonths);
  const paymentRatio = (monthlyRate * growth) / (growth - 1);
  return multiplyAgorot(principal, paymentRatio);
}

/** True when `payment` doesn't even cover this month's interest — the balance will grow, not shrink. */
export function isNegativeAmortization(payment: Agorot, balance: Agorot, aprBps: BasisPoints): boolean {
  return payment < accrueInterest(balance, aprBps);
}

/**
 * Builds a month-by-month amortization schedule for a single debt. Models
 * negative amortization for real (rather than merely detecting it): if
 * `payment + extraPayment` doesn't cover a month's interest, the
 * shortfall capitalizes onto the balance — `principalPortion` for that
 * month is negative, and `remainingBalance` goes *up*.
 */
export function buildAmortizationSchedule(
  principal: Agorot,
  aprBps: BasisPoints,
  payment: Agorot,
  options: { extraPayment?: Agorot; maxMonths?: number } = {},
): AmortizationScheduleEntry[] {
  const extra = options.extraPayment ?? agorot(0);
  const maxMonths = options.maxMonths ?? MAX_SIMULATED_MONTHS;

  const schedule: AmortizationScheduleEntry[] = [];
  let balance = principal;
  let month = 0;

  while (balance > 0 && month < maxMonths) {
    month++;
    const interest = accrueInterest(balance, aprBps);
    const totalPayment = addAgorot(payment, extra);

    if (totalPayment >= interest) {
      let principalPortion = subtractAgorot(totalPayment, interest);
      let actualPayment = totalPayment;
      if (principalPortion > balance) {
        // Final payment: don't overpay past what's actually owed.
        principalPortion = balance;
        actualPayment = addAgorot(balance, interest);
      }
      balance = subtractAgorot(balance, principalPortion);
      schedule.push({ month, payment: actualPayment, principalPortion, interestPortion: interest, remainingBalance: balance });
    } else {
      // Negative amortization: unpaid interest capitalizes onto the balance.
      const shortfall = subtractAgorot(interest, totalPayment);
      balance = addAgorot(balance, shortfall);
      schedule.push({
        month,
        payment: totalPayment,
        principalPortion: agorot(-shortfall),
        interestPortion: interest,
        remainingBalance: balance,
      });
    }
  }

  return schedule;
}

export type PayoffSummary = {
  monthsSimulated: number;
  totalInterestPaid: Agorot;
  totalPaid: Agorot;
  /** False if the debt never reached a zero balance within the simulation cap (e.g. negative amortization). */
  payoffAchieved: boolean;
};

export function summarizePayoff(schedule: readonly AmortizationScheduleEntry[]): PayoffSummary {
  const totalInterestPaid = addAgorot(...schedule.map((e) => e.interestPortion));
  const totalPaid = addAgorot(...schedule.map((e) => e.payment));
  const last = schedule.at(-1);

  return {
    monthsSimulated: schedule.length,
    totalInterestPaid,
    totalPaid,
    payoffAchieved: last !== undefined && last.remainingBalance <= 0,
  };
}

export type ExtraPaymentImpact = {
  baseline: PayoffSummary;
  withExtra: PayoffSummary;
  monthsSaved: number;
  interestSaved: Agorot;
};

/** Compares paying only the minimum against adding a fixed extra payment every month. */
export function simulateExtraPayment(
  principal: Agorot,
  aprBps: BasisPoints,
  minimumPayment: Agorot,
  extraPayment: Agorot,
): ExtraPaymentImpact {
  const baseline = summarizePayoff(buildAmortizationSchedule(principal, aprBps, minimumPayment));
  const withExtra = summarizePayoff(buildAmortizationSchedule(principal, aprBps, minimumPayment, { extraPayment }));

  return {
    baseline,
    withExtra,
    monthsSaved: baseline.monthsSimulated - withExtra.monthsSimulated,
    interestSaved: subtractAgorot(baseline.totalInterestPaid, withExtra.totalInterestPaid),
  };
}

export type DebtInput = {
  id: string;
  balance: Agorot;
  aprBps: BasisPoints;
  minimumPayment: Agorot;
};

export type PayoffPlanResult = {
  order: readonly string[];
  monthsToPayoff: number;
  totalInterestPaid: Agorot;
};

/**
 * Simulates paying off multiple debts at once: every debt gets its
 * minimum payment each month; the extra budget (plus the minimum
 * payments freed up by any already-paid-off debt — the actual "snowball"
 * mechanic) all goes to whichever debt is first in `order` and still has
 * a balance.
 */
function simulateMultiDebtPayoff(
  debts: readonly DebtInput[],
  extraBudget: Agorot,
  order: readonly string[],
): { monthsToPayoff: number; totalInterestPaid: Agorot } {
  const balances = new Map(debts.map((d) => [d.id, d.balance]));
  const aprById = new Map(debts.map((d) => [d.id, d.aprBps]));
  const minimumById = new Map(debts.map((d) => [d.id, d.minimumPayment]));

  let totalInterestPaid = agorot(0);
  let month = 0;

  const hasRemainingBalance = () => [...balances.values()].some((b) => b > 0);

  while (hasRemainingBalance() && month < MAX_SIMULATED_MONTHS) {
    month++;
    let rolledOverMinimums = agorot(0);

    for (const id of order) {
      const balance = balances.get(id)!;
      if (balance <= 0) {
        rolledOverMinimums = addAgorot(rolledOverMinimums, minimumById.get(id)!);
        continue;
      }

      const interest = accrueInterest(balance, aprById.get(id)!);
      totalInterestPaid = addAgorot(totalInterestPaid, interest);

      const payment = minimumById.get(id)!;
      const principalPortion = payment > interest ? subtractAgorot(payment, interest) : agorot(0);
      const newBalance = principalPortion >= balance ? agorot(0) : subtractAgorot(balance, principalPortion);
      balances.set(id, newBalance);
    }

    const availableExtra = addAgorot(extraBudget, rolledOverMinimums);
    const target = order.find((id) => balances.get(id)! > 0);
    if (target && availableExtra > 0) {
      const balance = balances.get(target)!;
      const applied = availableExtra > balance ? balance : availableExtra;
      balances.set(target, subtractAgorot(balance, applied));
    }
  }

  return { monthsToPayoff: month, totalInterestPaid };
}

export type AvalancheVsSnowballResult = {
  avalanche: PayoffPlanResult;
  snowball: PayoffPlanResult;
};

/**
 * Avalanche: highest APR first (minimizes total interest paid).
 * Snowball: smallest balance first (minimizes time to the first payoff,
 * for psychological momentum) — the two orderings usually disagree, and
 * the whole point of computing both is to show the user the tradeoff
 * rather than picking one for them.
 */
export function compareAvalancheVsSnowball(
  debts: readonly DebtInput[],
  extraBudget: Agorot,
): AvalancheVsSnowballResult {
  const avalancheOrder = [...debts].sort((a, b) => b.aprBps - a.aprBps).map((d) => d.id);
  const snowballOrder = [...debts].sort((a, b) => a.balance - b.balance).map((d) => d.id);

  const avalancheResult = simulateMultiDebtPayoff(debts, extraBudget, avalancheOrder);
  const snowballResult = simulateMultiDebtPayoff(debts, extraBudget, snowballOrder);

  return {
    avalanche: { order: avalancheOrder, ...avalancheResult },
    snowball: { order: snowballOrder, ...snowballResult },
  };
}
