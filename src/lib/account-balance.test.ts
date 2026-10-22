import { describe, expect, it } from "vitest";
import { nativeAmount } from "./currency";
import { currentBalanceAgorot, describeBalanceHistory, settleBalance, type AccountBalanceParts } from "./account-balance";

function parts(overrides: Partial<AccountBalanceParts>): AccountBalanceParts {
  return {
    accountType: "CHECKING",
    currency: "ILS",
    typedNative: 0,
    sameCurrencyFlowNative: 0,
    otherCurrencyFlowAgorot: 0,
    ...overrides,
  };
}

describe("settleBalance", () => {
  it("is the typed balance when nothing has moved since", () => {
    const settled = settleBalance(parts({ typedNative: 1_000_000 }), 1);
    expect(settled.currentNative).toBe(1_000_000);
    expect(settled.changeNative).toBe(0);
  });

  it("adds income and subtracts spending recorded after the typed balance", () => {
    // Typed 10,000.00; spent 250.00 and received 1,000.00 since.
    const settled = settleBalance(parts({ typedNative: 1_000_000, sameCurrencyFlowNative: -25_000 + 100_000 }), 1);
    expect(settled.currentNative).toBe(1_075_000);
    expect(settled.changeNative).toBe(75_000);
  });

  it("lets a deposit account go negative: an overdraft is real", () => {
    expect(settleBalance(parts({ typedNative: 10_000, sameCurrencyFlowNative: -60_000 }), 1).currentNative).toBe(-50_000);
  });

  it("applies the same rule to savings as to checking", () => {
    expect(settleBalance(parts({ accountType: "SAVINGS", typedNative: 500_000, sameCurrencyFlowNative: 100_000 }), 1).currentNative).toBe(600_000);
  });

  describe("a credit card, which stores money OWED as a positive number", () => {
    const card = (flow: number) => parts({ accountType: "CREDIT_CARD", typedNative: 300_000, sameCurrencyFlowNative: flow });

    it("owes more after a charge", () => {
      const settled = settleBalance(card(-120_000), 1);
      expect(settled.currentNative).toBe(420_000);
      expect(settled.changeNative).toBe(120_000);
    });

    it("owes less after a payment", () => {
      expect(settleBalance(card(100_000), 1).currentNative).toBe(200_000);
    });

    it("goes negative when overpaid, a credit with the bank", () => {
      expect(settleBalance(card(450_000), 1).currentNative).toBe(-150_000);
    });
  });

  describe("an account in a foreign currency", () => {
    // 1 USD = 3.5 ILS.
    const RATE = 3.5;

    it("rolls forward in the account's own currency, untouched by the exchange rate", () => {
      const usd = parts({ currency: "USD", typedNative: 100_000, sameCurrencyFlowNative: -20_000 });
      expect(settleBalance(usd, RATE).currentNative).toBe(80_000);
      // The same account at a different rate holds the same dollars.
      expect(settleBalance(usd, 4.2).currentNative).toBe(80_000);
    });

    it("converts rows entered in another currency at the latest rate", () => {
      // 700.00 ILS spent (a row entered in shekels on a dollar account) = 200.00 USD.
      const usd = parts({ currency: "USD", typedNative: 100_000, otherCurrencyFlowAgorot: -70_000 });
      expect(settleBalance(usd, RATE).currentNative).toBe(80_000);
    });

    it("adds both kinds of movement together", () => {
      const usd = parts({ currency: "USD", typedNative: 100_000, sameCurrencyFlowNative: -10_000, otherCurrencyFlowAgorot: -35_000 });
      expect(settleBalance(usd, RATE).currentNative).toBe(80_000);
    });

    it("a shekel account takes rows in other currencies at their frozen shekel amount directly", () => {
      const ils = parts({ currency: "ILS", typedNative: 1_000_000, sameCurrencyFlowNative: -10_000, otherCurrencyFlowAgorot: -34_000 });
      expect(settleBalance(ils, 99).currentNative).toBe(956_000);
    });
  });
});

describe("currentBalanceAgorot", () => {
  it("converts the balance NOW at the latest rate, once", () => {
    // 800.00 USD at 3.5 = 2,800.00 ILS.
    const usd = parts({ currency: "USD", typedNative: 100_000, sameCurrencyFlowNative: -20_000 });
    expect(currentBalanceAgorot(usd, 3.5)).toBe(280_000);
  });

  it("equals the typed balance's value when nothing has moved", () => {
    expect(currentBalanceAgorot(parts({ currency: "TRY", typedNative: 123_456 }), 0.0623)).toBe(
      currentBalanceAgorot(parts({ currency: "TRY", typedNative: 123_456, sameCurrencyFlowNative: 0 }), 0.0623),
    );
  });

  it("does not let a rate move the movement away from the opening figure", () => {
    // Converting opening and movement separately could differ by an agorah; one conversion cannot.
    const a = parts({ currency: "EUR", typedNative: 33_333, sameCurrencyFlowNative: 66_667 });
    expect(currentBalanceAgorot(a, 4.1)).toBe(currentBalanceAgorot(parts({ currency: "EUR", typedNative: 100_000 }), 4.1));
  });

  it("is the same figure for a shekel account whatever the rate argument says", () => {
    expect(currentBalanceAgorot(parts({ typedNative: 555_555, sameCurrencyFlowNative: -5 }), 123)).toBe(555_550);
  });
});

describe("describeBalanceHistory", () => {
  const base = { accountType: "CHECKING", currency: "ILS" as const, typedNative: 1_000_000, balanceAsOf: new Date("2026-09-30T00:00:00Z") };

  it("says what was entered and when, with no movement", () => {
    expect(describeBalanceHistory({ ...base, changeNative: nativeAmount(0) })).toBe(
      "You entered ₪10,000.00 as of 2026-09-30. No transactions since.",
    );
  });

  it("shows income since as a plus and spending as a minus", () => {
    expect(describeBalanceHistory({ ...base, changeNative: nativeAmount(75_000) })).toBe(
      "You entered ₪10,000.00 as of 2026-09-30. Transactions since: +₪750.00.",
    );
    expect(describeBalanceHistory({ ...base, changeNative: nativeAmount(-125_000) })).toBe(
      "You entered ₪10,000.00 as of 2026-09-30. Transactions since: -₪1,250.00.",
    );
  });

  it("says when no balance day was given", () => {
    expect(describeBalanceHistory({ ...base, balanceAsOf: null, changeNative: nativeAmount(0) })).toBe(
      "You entered ₪10,000.00 when the account was added. No transactions since.",
    );
  });

  it("speaks of money owed for a card", () => {
    const card = { ...base, accountType: "CREDIT_CARD", typedNative: 100_000 };
    expect(describeBalanceHistory({ ...card, changeNative: nativeAmount(20_000) })).toBe(
      "You entered ₪1,000.00 owed as of 2026-09-30. Transactions since: ₪200.00 more owed.",
    );
    expect(describeBalanceHistory({ ...card, changeNative: nativeAmount(-30_000) })).toBe(
      "You entered ₪1,000.00 owed as of 2026-09-30. Transactions since: ₪300.00 less owed.",
    );
  });

  it("uses the account's own currency symbol", () => {
    expect(describeBalanceHistory({ ...base, currency: "TRY", typedNative: 50_000, changeNative: nativeAmount(-10_000) })).toBe(
      "You entered ₺500.00 as of 2026-09-30. Transactions since: -₺100.00.",
    );
  });
});
