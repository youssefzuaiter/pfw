import { describe, expect, it } from "vitest";
import { bps } from "./apr";
import {
  buildAmortizationSchedule,
  calculateMonthlyPayment,
  compareAvalancheVsSnowball,
  isNegativeAmortization,
  simulateExtraPayment,
  summarizePayoff,
} from "./debt-math";
import { agorot } from "./money";

describe("calculateMonthlyPayment()", () => {
  it("matches the standard closed-form mortgage payment (₪200,000 @ 6% / 360mo -> ~₪1,199.10)", () => {
    const payment = calculateMonthlyPayment(agorot(20_000_000), bps(600), 360);
    // Independently computed via M = P*r(1+r)^n/((1+r)^n-1).
    expect(payment).toBeGreaterThanOrEqual(119_900);
    expect(payment).toBeLessThanOrEqual(119_921);
  });

  it("degenerates to a plain equal split at 0% APR", () => {
    expect(calculateMonthlyPayment(agorot(120_000), bps(0), 12)).toBe(10_000);
  });

  it("rejects a non-positive term", () => {
    expect(() => calculateMonthlyPayment(agorot(1000), bps(500), 0)).toThrow(RangeError);
    expect(() => calculateMonthlyPayment(agorot(1000), bps(500), -1)).toThrow(RangeError);
  });

  it("rejects a non-integer term", () => {
    expect(() => calculateMonthlyPayment(agorot(1000), bps(500), 12.5)).toThrow(RangeError);
  });
});

describe("isNegativeAmortization()", () => {
  it("is true when the payment doesn't cover a month's interest", () => {
    // 100,000 agorot balance @ 24% APR -> ~2,000 agorot monthly interest.
    expect(isNegativeAmortization(agorot(1_000), agorot(100_000), bps(2_400))).toBe(true);
  });

  it("is false when the payment covers interest with room to spare", () => {
    expect(isNegativeAmortization(agorot(50_000), agorot(100_000), bps(2_400))).toBe(false);
  });
});

describe("buildAmortizationSchedule()", () => {
  it("fully amortizes a standard loan to exactly zero, within a payment or two of the nominal term", () => {
    // The fixed payment is rounded to the nearest agorot, so it won't
    // amortize to *exactly* zero at *exactly* 24 months — real fixed-rate
    // loans have this same "final payment differs slightly" reality for
    // the same reason. What must hold exactly is that it reaches zero,
    // and does so close to the nominal term, not drifting indefinitely.
    const principal = agorot(1_200_000);
    const aprBps = bps(1200);
    const payment = calculateMonthlyPayment(principal, aprBps, 24);
    const schedule = buildAmortizationSchedule(principal, aprBps, payment);

    expect(schedule.length).toBeGreaterThanOrEqual(24);
    expect(schedule.length).toBeLessThanOrEqual(25);
    expect(schedule.at(-1)?.remainingBalance).toBe(0);
    // Every interim month actually reduces the balance.
    for (let i = 1; i < schedule.length; i++) {
      expect(schedule[i].remainingBalance).toBeLessThan(schedule[i - 1].remainingBalance);
    }
  });

  it("an extra payment shortens the payoff schedule", () => {
    const principal = agorot(1_200_000);
    const aprBps = bps(1200);
    const payment = calculateMonthlyPayment(principal, aprBps, 24);

    const baseline = buildAmortizationSchedule(principal, aprBps, payment);
    const accelerated = buildAmortizationSchedule(principal, aprBps, payment, { extraPayment: agorot(20_000) });

    expect(accelerated.length).toBeLessThan(baseline.length);
    expect(accelerated.at(-1)?.remainingBalance).toBe(0);
  });

  it("models real negative amortization: the balance grows when payment < interest", () => {
    const schedule = buildAmortizationSchedule(agorot(100_000), bps(2_400), agorot(1_000), { maxMonths: 6 });

    expect(schedule).toHaveLength(6);
    for (const entry of schedule) {
      expect(entry.principalPortion).toBeLessThan(0);
    }
    // Balance strictly increases every month under sustained negative amortization.
    for (let i = 1; i < schedule.length; i++) {
      expect(schedule[i].remainingBalance).toBeGreaterThan(schedule[i - 1].remainingBalance);
    }
  });

  it("respects the maxMonths safety cap instead of looping forever", () => {
    const schedule = buildAmortizationSchedule(agorot(100_000), bps(2_400), agorot(0), { maxMonths: 3 });
    expect(schedule).toHaveLength(3);
  });
});

describe("summarizePayoff()", () => {
  it("reports payoffAchieved: true when the schedule reaches zero", () => {
    const principal = agorot(120_000);
    const aprBps = bps(0);
    const payment = calculateMonthlyPayment(principal, aprBps, 12);
    const summary = summarizePayoff(buildAmortizationSchedule(principal, aprBps, payment));

    expect(summary.payoffAchieved).toBe(true);
    expect(summary.monthsSimulated).toBe(12);
    expect(summary.totalInterestPaid).toBe(0);
    expect(summary.totalPaid).toBe(120_000);
  });

  it("reports payoffAchieved: false for a capped negative-amortization run", () => {
    const schedule = buildAmortizationSchedule(agorot(100_000), bps(2_400), agorot(1_000), { maxMonths: 3 });
    expect(summarizePayoff(schedule).payoffAchieved).toBe(false);
  });
});

describe("simulateExtraPayment()", () => {
  it("shows zero savings when the extra payment is zero", () => {
    const principal = agorot(1_200_000);
    const aprBps = bps(1200);
    const payment = calculateMonthlyPayment(principal, aprBps, 24);
    const impact = simulateExtraPayment(principal, aprBps, payment, agorot(0));

    expect(impact.monthsSaved).toBe(0);
    expect(impact.interestSaved).toBe(0);
  });

  it("shows positive months and interest saved for a real extra payment", () => {
    const principal = agorot(1_200_000);
    const aprBps = bps(1200);
    const payment = calculateMonthlyPayment(principal, aprBps, 24);
    const impact = simulateExtraPayment(principal, aprBps, payment, agorot(20_000));

    expect(impact.monthsSaved).toBeGreaterThan(0);
    expect(impact.interestSaved).toBeGreaterThan(0);
  });
});

describe("compareAvalancheVsSnowball()", () => {
  const highAprSmallBalance = {
    id: "credit-card",
    balance: agorot(500_000),
    aprBps: bps(2_400),
    minimumPayment: agorot(20_000),
  };
  const lowAprLargeBalance = {
    id: "mortgage",
    balance: agorot(5_000_000),
    aprBps: bps(350),
    minimumPayment: agorot(30_000),
  };
  const debts = [lowAprLargeBalance, highAprSmallBalance];
  const extraBudget = agorot(50_000);

  it("avalanche targets the highest-APR debt first", () => {
    const { avalanche } = compareAvalancheVsSnowball(debts, extraBudget);
    expect(avalanche.order[0]).toBe("credit-card");
  });

  it("snowball targets the smallest-balance debt first", () => {
    const { snowball } = compareAvalancheVsSnowball(debts, extraBudget);
    expect(snowball.order[0]).toBe("credit-card"); // also the smallest balance here
  });

  it("orders can genuinely disagree when APR rank and balance rank differ", () => {
    const debtsWithConflictingOrder = [
      { id: "small-low-apr", balance: agorot(100_000), aprBps: bps(300), minimumPayment: agorot(5_000) },
      { id: "large-high-apr", balance: agorot(900_000), aprBps: bps(2_200), minimumPayment: agorot(20_000) },
    ];
    const { avalanche, snowball } = compareAvalancheVsSnowball(debtsWithConflictingOrder, agorot(30_000));

    expect(avalanche.order[0]).toBe("large-high-apr");
    expect(snowball.order[0]).toBe("small-low-apr");
  });

  it("avalanche never pays more total interest than snowball for the same debts and budget", () => {
    const { avalanche, snowball } = compareAvalancheVsSnowball(debts, extraBudget);
    expect(avalanche.totalInterestPaid).toBeLessThanOrEqual(snowball.totalInterestPaid);
  });

  it("both strategies actually pay off all debts within the simulation window", () => {
    const { avalanche, snowball } = compareAvalancheVsSnowball(debts, extraBudget);
    expect(avalanche.monthsToPayoff).toBeLessThan(600);
    expect(snowball.monthsToPayoff).toBeLessThan(600);
  });

  it("hand-traced: the freed-up minimum payment rolls onto the next debt the month after payoff", () => {
    // 0% APR on both debts removes interest as a variable, so the exact
    // month-by-month balances are fully predictable by hand:
    //   Small (200 balance, 100/mo minimum) pays off in exactly month 2.
    //   Large (1000 balance, 100/mo minimum) then gets its own 100/mo
    //   PLUS Small's freed-up 100/mo from month 3 onward.
    // Month-by-month Large balance: 1000 -(100)-> 900 -(100)-> 800
    //   -(100+100)-> 600 -(200)-> 400 -(200)-> 200 -(200)-> 0.
    // That's 6 months total, and every extra agorot is accounted for —
    // zero interest anywhere, since both debts are 0% APR.
    const small = { id: "small", balance: agorot(200), aprBps: bps(0), minimumPayment: agorot(100) };
    const large = { id: "large", balance: agorot(1000), aprBps: bps(0), minimumPayment: agorot(100) };

    // Both avalanche (APR tie, stable sort preserves input order) and
    // snowball (small's balance is genuinely smaller) land on [small,
    // large] here, so both should match this exact trace.
    const { avalanche, snowball } = compareAvalancheVsSnowball([small, large], agorot(0));

    expect(avalanche.order).toEqual(["small", "large"]);
    expect(avalanche.monthsToPayoff).toBe(6);
    expect(avalanche.totalInterestPaid).toBe(0);
    expect(snowball.monthsToPayoff).toBe(6);
    expect(snowball.totalInterestPaid).toBe(0);
  });

  it("a debt whose balance is already zero is skipped entirely and contributes no interest", () => {
    const alreadyPaidOff = { id: "done", balance: agorot(0), aprBps: bps(2000), minimumPayment: agorot(500) };
    const remaining = { id: "remaining", balance: agorot(1000), aprBps: bps(0), minimumPayment: agorot(1000) };

    const { avalanche } = compareAvalancheVsSnowball([alreadyPaidOff, remaining], agorot(0));

    expect(avalanche.monthsToPayoff).toBe(1);
    expect(avalanche.totalInterestPaid).toBe(0);
  });
});
