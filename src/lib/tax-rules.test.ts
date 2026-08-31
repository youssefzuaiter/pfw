import { describe, expect, it } from "vitest";
import { agorot } from "./money";
import {
  classifyHoldingTerm,
  computeCapitalGainsTax,
  computeStackedBracketTax,
  defaultTaxProfile,
  netGainsByTerm,
  US_LTCG_BRACKETS,
  US_ORDINARY_BRACKETS,
  type TaxProfileInput,
} from "./tax-rules";

function usProfile(overrides: Partial<TaxProfileInput> = {}): TaxProfileInput {
  return { ...defaultTaxProfile("US"), ...overrides };
}

function deProfile(overrides: Partial<TaxProfileInput> = {}): TaxProfileInput {
  return { ...defaultTaxProfile("DE"), ...overrides };
}

function intlProfile(overrides: Partial<TaxProfileInput> = {}): TaxProfileInput {
  return { ...defaultTaxProfile("INTL"), ...overrides };
}

describe("classifyHoldingTerm()", () => {
  it("classifies US gains as short-term at exactly one year and long-term beyond it", () => {
    expect(classifyHoldingTerm(365, "US")).toBe("SHORT");
    expect(classifyHoldingTerm(366, "US")).toBe("LONG");
    expect(classifyHoldingTerm(1, "US")).toBe("SHORT");
  });

  it("treats Germany and the generic international model as flat regardless of holding period", () => {
    expect(classifyHoldingTerm(1, "DE")).toBe("FLAT");
    expect(classifyHoldingTerm(10_000, "DE")).toBe("FLAT");
    expect(classifyHoldingTerm(1, "INTL")).toBe("FLAT");
    expect(classifyHoldingTerm(10_000, "INTL")).toBe("FLAT");
  });
});

describe("computeStackedBracketTax()", () => {
  it("taxes an amount entirely within the first bracket at that bracket's rate", () => {
    expect(computeStackedBracketTax(agorot(0), agorot(4_300_000), US_ORDINARY_BRACKETS)).toBe(430_000);
  });

  it("splits an amount crossing a bracket boundary proportionally across both rates", () => {
    // 4,300,000 @ 10% + 1,000,000 @ 12%
    expect(computeStackedBracketTax(agorot(0), agorot(5_300_000), US_ORDINARY_BRACKETS)).toBe(550_000);
  });

  it("stacks entirely on the marginal rate when baseIncome already fills lower brackets", () => {
    expect(computeStackedBracketTax(agorot(4_300_000), agorot(1_000_000), US_ORDINARY_BRACKETS)).toBe(120_000);
  });

  it("applies the uncapped top bracket's rate beyond its floor", () => {
    expect(computeStackedBracketTax(agorot(225_450_000), agorot(1_000_000), US_ORDINARY_BRACKETS)).toBe(370_000);
  });

  it("returns zero tax for a non-positive amount", () => {
    expect(computeStackedBracketTax(agorot(0), agorot(0), US_ORDINARY_BRACKETS)).toBe(0);
    expect(computeStackedBracketTax(agorot(1_000_000), agorot(-500), US_ORDINARY_BRACKETS)).toBe(0);
  });

  it("applies the 0% long-term bracket up to its ceiling", () => {
    expect(computeStackedBracketTax(agorot(0), agorot(10_000_000), US_LTCG_BRACKETS)).toBe(0);
  });
});

describe("netGainsByTerm()", () => {
  it("buckets gains by their classified term", () => {
    const result = netGainsByTerm([
      { realizedGainAgorot: agorot(1_000), term: "SHORT" },
      { realizedGainAgorot: agorot(2_000), term: "SHORT" },
      { realizedGainAgorot: agorot(500), term: "LONG" },
      { realizedGainAgorot: agorot(300), term: "FLAT" },
    ]);
    expect(result).toEqual({
      shortTermGainAgorot: 3_000,
      longTermGainAgorot: 500,
      flatGainAgorot: 300,
    });
  });

  it("returns all-zero buckets for an empty list", () => {
    expect(netGainsByTerm([])).toEqual({ shortTermGainAgorot: 0, longTermGainAgorot: 0, flatGainAgorot: 0 });
  });
});

describe("computeCapitalGainsTax() — shared behavior", () => {
  it("owes no tax on a net loss, in any jurisdiction, and notes that carryforward isn't modeled", () => {
    const gains = { shortTermGainAgorot: agorot(-100_000), longTermGainAgorot: agorot(-50_000), flatGainAgorot: agorot(0) };
    for (const profile of [usProfile(), deProfile(), intlProfile()]) {
      const result = computeCapitalGainsTax(profile, gains);
      expect(result.taxOwedAgorot).toBe(0);
      expect(result.effectiveRate).toBeNull();
      expect(result.notes.join(" ")).toMatch(/loss/i);
    }
  });

  it("owes no tax when total gain is exactly zero", () => {
    const gains = { shortTermGainAgorot: agorot(100_000), longTermGainAgorot: agorot(-100_000), flatGainAgorot: agorot(0) };
    const result = computeCapitalGainsTax(usProfile(), gains);
    expect(result.taxOwedAgorot).toBe(0);
  });
});

describe("computeCapitalGainsTax() — US", () => {
  it("owes nothing on a long-term gain fully inside the 0% bracket", () => {
    const gains = { shortTermGainAgorot: agorot(0), longTermGainAgorot: agorot(10_000_000), flatGainAgorot: agorot(0) };
    const result = computeCapitalGainsTax(usProfile(), gains);
    expect(result.taxOwedAgorot).toBe(0);
    expect(result.effectiveRate).toBe(0);
  });

  it("taxes the portion of a long-term gain above the 0% bracket at 15%", () => {
    const gains = { shortTermGainAgorot: agorot(0), longTermGainAgorot: agorot(20_000_000), flatGainAgorot: agorot(0) };
    const result = computeCapitalGainsTax(usProfile(), gains);
    expect(result.taxOwedAgorot).toBe(390_000); // (20M - 17.4M) * 15%
  });

  it("stacks short-term gains as ordinary income on top of other income", () => {
    const gains = { shortTermGainAgorot: agorot(1_000_000), longTermGainAgorot: agorot(0), flatGainAgorot: agorot(0) };
    const result = computeCapitalGainsTax(usProfile({ otherOrdinaryIncomeAgorot: agorot(4_300_000) }), gains);
    expect(result.taxOwedAgorot).toBe(120_000); // entirely within the 12% bracket
  });

  it("nets a short-term loss against a long-term gain before taxing either", () => {
    const gains = { shortTermGainAgorot: agorot(-50_000), longTermGainAgorot: agorot(200_000), flatGainAgorot: agorot(0) };
    const result = computeCapitalGainsTax(usProfile(), gains);
    expect(result.taxableGainAgorot).toBe(150_000);
    expect(result.taxOwedAgorot).toBe(0); // net 150,000 long-term gain still inside the 0% bracket
  });

  it("nets a long-term loss against a short-term gain before taxing either", () => {
    const gains = { shortTermGainAgorot: agorot(200_000), longTermGainAgorot: agorot(-50_000), flatGainAgorot: agorot(0) };
    const result = computeCapitalGainsTax(usProfile(), gains);
    expect(result.taxableGainAgorot).toBe(150_000);
  });

  it("adds the 3.8% NIIT surtax only when opted in and only above the MAGI threshold", () => {
    const gains = { shortTermGainAgorot: agorot(0), longTermGainAgorot: agorot(10_000_000), flatGainAgorot: agorot(0) };
    const withoutNiit = computeCapitalGainsTax(usProfile({ otherOrdinaryIncomeAgorot: agorot(70_000_000) }), gains);
    const withNiit = computeCapitalGainsTax(
      usProfile({ otherOrdinaryIncomeAgorot: agorot(70_000_000), includeNiit: true }),
      gains,
    );
    // Total taxable income (80M) exceeds the 74M threshold by 6M, all of which is investment income.
    expect(withNiit.taxOwedAgorot - withoutNiit.taxOwedAgorot).toBe(Math.round(6_000_000 * 0.038));
    expect(withNiit.notes.join(" ")).toMatch(/Net Investment Income Tax/);
  });

  it("does not apply NIIT when total income stays under the threshold", () => {
    const gains = { shortTermGainAgorot: agorot(0), longTermGainAgorot: agorot(1_000_000), flatGainAgorot: agorot(0) };
    const result = computeCapitalGainsTax(usProfile({ includeNiit: true, otherOrdinaryIncomeAgorot: agorot(1_000_000) }), gains);
    expect(result.notes.some((n) => n.includes("Net Investment Income Tax"))).toBe(true);
    // Well under the 74,000,000 threshold, so the surtax contributes nothing.
    const withoutNiit = computeCapitalGainsTax(usProfile({ otherOrdinaryIncomeAgorot: agorot(1_000_000) }), gains);
    expect(result.taxOwedAgorot).toBe(withoutNiit.taxOwedAgorot);
  });
});

describe("computeCapitalGainsTax() — Germany", () => {
  it("applies the flat rate plus solidarity surcharge above the allowance", () => {
    const gains = { shortTermGainAgorot: agorot(0), longTermGainAgorot: agorot(0), flatGainAgorot: agorot(1_000_000) };
    const result = computeCapitalGainsTax(deProfile(), gains);
    // allowance 400,000 -> taxable 600,000; 25% = 150,000; +5.5% soli = 8,250
    expect(result.allowanceAppliedAgorot).toBe(400_000);
    expect(result.taxableGainAgorot).toBe(600_000);
    expect(result.taxOwedAgorot).toBe(158_250);
  });

  it("adds church tax as a percentage of the base tax when opted in", () => {
    const gains = { shortTermGainAgorot: agorot(0), longTermGainAgorot: agorot(0), flatGainAgorot: agorot(1_000_000) };
    const result = computeCapitalGainsTax(deProfile({ churchTaxRate: 0.09 }), gains);
    // base tax 150,000 -> +5.5% soli (8,250) +9% church (13,500) = 171,750
    expect(result.taxOwedAgorot).toBe(171_750);
    expect(result.notes.join(" ")).toMatch(/church tax/i);
  });

  it("caps the allowance at the total gain rather than going negative", () => {
    const gains = { shortTermGainAgorot: agorot(0), longTermGainAgorot: agorot(0), flatGainAgorot: agorot(200_000) };
    const result = computeCapitalGainsTax(deProfile(), gains); // default allowance 400,000 > gain
    expect(result.allowanceAppliedAgorot).toBe(200_000);
    expect(result.taxableGainAgorot).toBe(0);
    expect(result.taxOwedAgorot).toBe(0);
  });

  it("ignores holding period entirely — short- and long-term gains are treated identically", () => {
    const shortOnly = { shortTermGainAgorot: agorot(1_000_000), longTermGainAgorot: agorot(0), flatGainAgorot: agorot(0) };
    const longOnly = { shortTermGainAgorot: agorot(0), longTermGainAgorot: agorot(1_000_000), flatGainAgorot: agorot(0) };
    expect(computeCapitalGainsTax(deProfile(), shortOnly).taxOwedAgorot).toBe(
      computeCapitalGainsTax(deProfile(), longOnly).taxOwedAgorot,
    );
  });

  describe("Kapitalerträge: dividend income folded into the taxable base", () => {
    it("defaults to zero dividend income and behaves exactly as before when omitted", () => {
      const gains = { shortTermGainAgorot: agorot(0), longTermGainAgorot: agorot(0), flatGainAgorot: agorot(1_000_000) };
      const withoutArg = computeCapitalGainsTax(deProfile(), gains);
      const withExplicitZero = computeCapitalGainsTax(deProfile(), gains, agorot(0));
      expect(withoutArg).toEqual(withExplicitZero);
      expect(withoutArg.dividendIncomeAgorot).toBe(0);
    });

    it("taxes dividend income and capital gains together under the SAME 25% flat rate + solidarity surcharge + shared allowance", () => {
      const gains = { shortTermGainAgorot: agorot(0), longTermGainAgorot: agorot(0), flatGainAgorot: agorot(600_000) };
      const dividendIncome = agorot(400_000);
      const result = computeCapitalGainsTax(deProfile(), gains, dividendIncome);
      // Combined base 600,000 + 400,000 = 1,000,000; allowance 400,000 -> taxable 600,000;
      // 25% = 150,000; +5.5% soli = 8,250 -> identical total to the pure-capital-gains
      // 1,000,000 case above, proving gains and dividends are genuinely pooled, not
      // taxed as two separate 400,000-allowance buckets.
      expect(result.dividendIncomeAgorot).toBe(400_000);
      expect(result.allowanceAppliedAgorot).toBe(400_000);
      expect(result.taxableGainAgorot).toBe(600_000);
      expect(result.taxOwedAgorot).toBe(158_250);
      expect(result.notes.join(" ")).toMatch(/Kapitalerträge taxable base/i);
    });

    it("owes tax on dividend income even when capital gains alone are a net loss", () => {
      const netLossGains = { shortTermGainAgorot: agorot(0), longTermGainAgorot: agorot(0), flatGainAgorot: agorot(-500_000) };
      const dividendIncome = agorot(1_000_000);
      const result = computeCapitalGainsTax(deProfile({ annualAllowanceAgorot: agorot(0) }), netLossGains, dividendIncome);
      // Combined base: -500,000 + 1,000,000 = 500,000 (positive) -> taxed, NOT the old
      // "totalGainAgorot <= 0 => no tax owed" short-circuit this task fixed.
      expect(result.taxableGainAgorot).toBe(500_000);
      expect(result.taxOwedAgorot).toBe(agorot(Math.round(500_000 * 0.25 * 1.055)));
      expect(result.taxOwedAgorot).toBeGreaterThan(0);
    });

    it("still owes zero tax when capital-gains losses exceed dividend income combined", () => {
      const netLossGains = { shortTermGainAgorot: agorot(0), longTermGainAgorot: agorot(0), flatGainAgorot: agorot(-1_000_000) };
      const dividendIncome = agorot(200_000);
      const result = computeCapitalGainsTax(deProfile(), netLossGains, dividendIncome);
      expect(result.taxOwedAgorot).toBe(0);
      expect(result.effectiveRate).toBeNull();
    });

    it("US and INTL models report dividend income back for context but never tax it", () => {
      const gains = { shortTermGainAgorot: agorot(0), longTermGainAgorot: agorot(1_000_000), flatGainAgorot: agorot(0) };
      const dividendIncome = agorot(300_000);

      const usWithDividends = computeCapitalGainsTax(usProfile(), gains, dividendIncome);
      const usWithoutDividends = computeCapitalGainsTax(usProfile(), gains);
      expect(usWithDividends.dividendIncomeAgorot).toBe(300_000);
      expect(usWithDividends.taxOwedAgorot).toBe(usWithoutDividends.taxOwedAgorot);
      expect(usWithDividends.notes.join(" ")).toMatch(/reported for context only/i);

      const flatGains = { shortTermGainAgorot: agorot(0), longTermGainAgorot: agorot(0), flatGainAgorot: agorot(1_000_000) };
      const intlWithDividends = computeCapitalGainsTax(intlProfile({ flatRatePercent: 0.2 }), flatGains, dividendIncome);
      const intlWithoutDividends = computeCapitalGainsTax(intlProfile({ flatRatePercent: 0.2 }), flatGains);
      expect(intlWithDividends.dividendIncomeAgorot).toBe(300_000);
      expect(intlWithDividends.taxOwedAgorot).toBe(intlWithoutDividends.taxOwedAgorot);
    });
  });
});

describe("computeCapitalGainsTax() — international generic", () => {
  it("applies the configured flat rate after the configured allowance", () => {
    const gains = { shortTermGainAgorot: agorot(0), longTermGainAgorot: agorot(0), flatGainAgorot: agorot(1_000_000) };
    const result = computeCapitalGainsTax(intlProfile({ flatRatePercent: 0.2, annualAllowanceAgorot: agorot(0) }), gains);
    expect(result.taxOwedAgorot).toBe(200_000);
  });

  it("reduces the taxable gain by the configured allowance first", () => {
    const gains = { shortTermGainAgorot: agorot(0), longTermGainAgorot: agorot(0), flatGainAgorot: agorot(1_000_000) };
    const result = computeCapitalGainsTax(
      intlProfile({ flatRatePercent: 0.2, annualAllowanceAgorot: agorot(300_000) }),
      gains,
    );
    expect(result.taxableGainAgorot).toBe(700_000);
    expect(result.taxOwedAgorot).toBe(140_000);
  });
});
