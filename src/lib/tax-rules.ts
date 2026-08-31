/**
 * Multi-jurisdiction capital-gains tax profile engine — pure functions
 * over already-computed lot data (`tax-lots.ts`), same `src/lib/`
 * convention as every other engine (AGENTS.md §3b): no DAL/DB access,
 * fully testable with plain data literals.
 *
 * **A deliberate, documented simplification, in the spirit of this app's
 * other simulators (Monte Carlo's single static allocation split, the
 * subscription radar's structural-not-brand heuristics):** this app has
 * exactly one reporting currency, ILS agorot (AGENTS.md law #3), so every
 * bracket threshold below is expressed in ILS agorot too — there is no
 * per-jurisdiction native-currency ledger to run US brackets in USD or
 * German brackets in EUR against. The US/Germany figures are illustrative:
 * published 2024 single-filer US federal thresholds and Germany's
 * statutory Abgeltungssteuer rate, converted ONCE via this app's own
 * `FALLBACK_RATES` (exchange-rate.ts) and rounded to clean shekel
 * figures — not a live, continuously-accurate translation of real tax law
 * denominated in a foreign currency. This is a simulator over mock data,
 * not a real tax-filing tool. Known, explicitly out of scope: US state/
 * local tax, non-single filing statuses, Germany's pre-2009 "Altbestand"
 * exemption, and any country-specific "international" bracket structure
 * (INTL is a generic flat-rate/allowance model a user tunes themselves).
 */

import { agorot, subtractAgorot, type Agorot } from "./money";

export type TaxJurisdiction = "US" | "DE" | "INTL";

export const TAX_JURISDICTIONS: readonly TaxJurisdiction[] = ["US", "DE", "INTL"];

export type HoldingTerm = "SHORT" | "LONG" | "FLAT";

/** US: more than one year held is long-term (IRS Publication 550). Also the default threshold INTL profiles fall back to when they choose to distinguish terms — though the built-in INTL model here is flat-rate and ignores it. */
export const US_LONG_TERM_THRESHOLD_DAYS = 365;

/**
 * Germany and the generic INTL model don't distinguish holding period in
 * this simulator (Germany's post-2009 Abgeltungssteuer genuinely doesn't;
 * INTL is a flat-rate placeholder) — everything is "FLAT" for them. US
 * gains are SHORT or LONG per the IRS one-year rule.
 */
export function classifyHoldingTerm(days: number, jurisdiction: TaxJurisdiction): HoldingTerm {
  if (jurisdiction !== "US") return "FLAT";
  return days > US_LONG_TERM_THRESHOLD_DAYS ? "LONG" : "SHORT";
}

// === Progressive bracket math ================================================

export type TaxBracket = { upToAgorot: Agorot | null; rate: number };

/**
 * Marginal/progressive tax on `amount` stacked on top of `baseIncome`
 * already earned — the standard "how much extra tax does this income
 * cause" calculation real tax software uses, not `amount * topRate`.
 * Brackets must be sorted ascending by `upToAgorot` (`null` = the top,
 * uncapped bracket, and must be last).
 */
export function computeStackedBracketTax(baseIncome: Agorot, amount: Agorot, brackets: readonly TaxBracket[]): Agorot {
  if (amount <= 0) return agorot(0);

  let remaining: number = amount;
  let cursor: number = baseIncome;
  let taxOwed = 0;

  for (const bracket of brackets) {
    if (remaining <= 0) break;
    const ceiling = bracket.upToAgorot ?? Infinity;
    if (cursor >= ceiling) continue;

    const roomInBracket = ceiling - cursor;
    const amountTaxedHere = Math.min(remaining, roomInBracket);
    taxOwed += amountTaxedHere * bracket.rate;
    cursor += amountTaxedHere;
    remaining -= amountTaxedHere;
  }

  return agorot(Math.round(taxOwed));
}

// === US federal brackets (single filer, illustrative — see file header) ====

/** 2024 published federal brackets, single filer, converted at FALLBACK_RATES.USD (3.7) and rounded to clean shekel figures. */
export const US_ORDINARY_BRACKETS: readonly TaxBracket[] = [
  { upToAgorot: agorot(4_300_000), rate: 0.1 },
  { upToAgorot: agorot(17_450_000), rate: 0.12 },
  { upToAgorot: agorot(37_200_000), rate: 0.22 },
  { upToAgorot: agorot(71_050_000), rate: 0.24 },
  { upToAgorot: agorot(90_200_000), rate: 0.32 },
  { upToAgorot: agorot(225_450_000), rate: 0.35 },
  { upToAgorot: null, rate: 0.37 },
];

/** 2024 published long-term capital-gains brackets, single filer, same conversion as above. */
export const US_LTCG_BRACKETS: readonly TaxBracket[] = [
  { upToAgorot: agorot(17_400_000), rate: 0 },
  { upToAgorot: agorot(192_000_000), rate: 0.15 },
  { upToAgorot: null, rate: 0.2 },
];

/** MAGI threshold (single) above which the Net Investment Income Tax surtax applies. */
export const US_NIIT_THRESHOLD_AGOROT: Agorot = agorot(74_000_000);
export const US_NIIT_RATE = 0.038;

// === Germany (Abgeltungssteuer) =============================================

export const DE_FLAT_RATE = 0.25;
export const DE_SOLIDARITY_SURCHARGE_RATE = 0.055;
/** Sparer-Pauschbetrag (single), converted at FALLBACK_RATES.EUR (4.0). */
export const DE_DEFAULT_ANNUAL_ALLOWANCE_AGOROT: Agorot = agorot(400_000);

// === INTL generic flat-rate model ===========================================

export const INTL_DEFAULT_FLAT_RATE = 0.2;
export const INTL_DEFAULT_ANNUAL_ALLOWANCE_AGOROT: Agorot = agorot(0);

/** A representative marginal rate per jurisdiction, used only as a fallback for the
 * harvesting radar's savings estimate when a portfolio has no positive unrealized gain
 * to derive an empirical blended rate from (build-tax-data.ts). Not used for the actual
 * tax liability calculation itself, which always runs the full bracket/flat-rate math. */
export const DEFAULT_MARGINAL_RATE_ESTIMATE: Record<Exclude<TaxJurisdiction, "INTL">, number> = {
  US: 0.15,
  DE: DE_FLAT_RATE * (1 + DE_SOLIDARITY_SURCHARGE_RATE),
};

// === Profile input & calculation ============================================

export type TaxProfileInput = {
  jurisdiction: TaxJurisdiction;
  /** US only: other ordinary income already earned this tax year — short-term gains stack on top of this for bracket purposes, and long-term gains stack on top of ordinary income + short-term gains. */
  otherOrdinaryIncomeAgorot: Agorot;
  /** US only: apply the 3.8% Net Investment Income Tax surtax above the MAGI threshold. */
  includeNiit: boolean;
  /** DE only: an additional flat percentage of the capital-gains tax itself (0 = the common case of no church tax registration). */
  churchTaxRate: number;
  /** DE/INTL: annual tax-free allowance applied against the total gain before the rate. */
  annualAllowanceAgorot: Agorot;
  /** INTL only: a flat rate applied to the allowance-reduced gain. */
  flatRatePercent: number;
};

export function defaultTaxProfile(jurisdiction: TaxJurisdiction): TaxProfileInput {
  return {
    jurisdiction,
    otherOrdinaryIncomeAgorot: agorot(0),
    includeNiit: false,
    churchTaxRate: 0,
    annualAllowanceAgorot:
      jurisdiction === "DE" ? DE_DEFAULT_ANNUAL_ALLOWANCE_AGOROT : INTL_DEFAULT_ANNUAL_ALLOWANCE_AGOROT,
    flatRatePercent: INTL_DEFAULT_FLAT_RATE,
  };
}

export type NetGainsByTerm = {
  shortTermGainAgorot: Agorot;
  longTermGainAgorot: Agorot;
  flatGainAgorot: Agorot;
};

/** Sums a set of classified disposals/lots into the three term buckets `computeCapitalGainsTax` expects. */
export function netGainsByTerm(
  gains: readonly { realizedGainAgorot: Agorot; term: HoldingTerm }[],
): NetGainsByTerm {
  let short = 0;
  let long = 0;
  let flat = 0;
  for (const gain of gains) {
    if (gain.term === "SHORT") short += gain.realizedGainAgorot;
    else if (gain.term === "LONG") long += gain.realizedGainAgorot;
    else flat += gain.realizedGainAgorot;
  }
  return { shortTermGainAgorot: agorot(short), longTermGainAgorot: agorot(long), flatGainAgorot: agorot(flat) };
}

export type TaxCalculationResult = {
  jurisdiction: TaxJurisdiction;
  shortTermGainAgorot: Agorot;
  longTermGainAgorot: Agorot;
  flatGainAgorot: Agorot;
  totalGainAgorot: Agorot;
  /**
   * Dividend income for the same period, informational for every
   * jurisdiction (always equal to whatever was passed into
   * `computeCapitalGainsTax`) but only actually FOLDED INTO the taxable
   * base for `DE` — see that branch's own comment for why. US/INTL
   * report it back unchanged for context but never tax it here; this
   * simulator's US/INTL models are capital-gains-only, per their own
   * existing scope (AGENTS.md §3r).
   */
  dividendIncomeAgorot: Agorot;
  allowanceAppliedAgorot: Agorot;
  taxableGainAgorot: Agorot;
  taxOwedAgorot: Agorot;
  /** `taxOwed / totalGain` (or, for DE, `taxOwed / (totalGain + dividendIncome)` — its actual taxable base), `null` when there's no positive amount to divide by. */
  effectiveRate: number | null;
  notes: string[];
};

/**
 * Computes simulated tax liability on a set of already-netted gains
 * (`tax-lots.ts` output, bucketed by `netGainsByTerm`), under one
 * jurisdiction's rules. A net loss overall never owes tax — loss
 * carryforward to future tax years is a real feature of every modeled
 * jurisdiction's law but isn't simulated here, flagged in `notes` rather
 * than silently assumed away.
 *
 * `dividendIncomeAgorot` (default 0) is the same-period dividend income
 * already received (`sumDividendIncome`, portfolio-analytics.ts) — only
 * Germany's Abgeltungssteuer model folds it into the taxed base here; see
 * that branch's own comment.
 */
export function computeCapitalGainsTax(
  profile: TaxProfileInput,
  gains: NetGainsByTerm,
  dividendIncomeAgorot: Agorot = agorot(0),
): TaxCalculationResult {
  const totalGainAgorot = agorot(gains.shortTermGainAgorot + gains.longTermGainAgorot + gains.flatGainAgorot);
  const notes: string[] = [];

  // For DE, "no tax owed" must be keyed on the COMBINED Kapitalerträge
  // base (capital gains + dividends), not capital gains alone — a
  // position can be a net capital LOSS this year while still owing tax
  // on real dividend income received, which the old totalGainAgorot-only
  // check would have silently zeroed out. US/INTL are unaffected: their
  // combined base always equals totalGainAgorot, since dividends aren't
  // folded into their taxable base at all in this simulator.
  const combinedTaxableBaseAgorot =
    profile.jurisdiction === "DE" ? agorot(totalGainAgorot + dividendIncomeAgorot) : totalGainAgorot;

  if (combinedTaxableBaseAgorot <= 0) {
    return {
      jurisdiction: profile.jurisdiction,
      shortTermGainAgorot: gains.shortTermGainAgorot,
      longTermGainAgorot: gains.longTermGainAgorot,
      flatGainAgorot: gains.flatGainAgorot,
      totalGainAgorot,
      dividendIncomeAgorot,
      allowanceAppliedAgorot: agorot(0),
      taxableGainAgorot: agorot(0),
      taxOwedAgorot: agorot(0),
      effectiveRate: null,
      notes: ["Net capital loss overall — no tax owed. Loss carryforward to future tax years is not modeled."],
    };
  }

  if (profile.jurisdiction === "US") {
    // A loss in one term can offset a gain in the other under US law —
    // net them against each other before applying either bracket table.
    let shortTerm: number = gains.shortTermGainAgorot;
    let longTerm: number = gains.longTermGainAgorot;
    if (shortTerm < 0 && longTerm > 0) {
      const offset = Math.min(-shortTerm, longTerm);
      shortTerm += offset;
      longTerm -= offset;
    } else if (longTerm < 0 && shortTerm > 0) {
      const offset = Math.min(-longTerm, shortTerm);
      longTerm += offset;
      shortTerm -= offset;
    }
    const taxableShortTerm = agorot(Math.max(0, shortTerm));
    const taxableLongTerm = agorot(Math.max(0, longTerm));

    const shortTermTax = computeStackedBracketTax(profile.otherOrdinaryIncomeAgorot, taxableShortTerm, US_ORDINARY_BRACKETS);
    const longTermStackBase = agorot(profile.otherOrdinaryIncomeAgorot + taxableShortTerm);
    const longTermTax = computeStackedBracketTax(longTermStackBase, taxableLongTerm, US_LTCG_BRACKETS);

    let niitTax = agorot(0);
    if (profile.includeNiit) {
      const totalTaxableIncome = profile.otherOrdinaryIncomeAgorot + taxableShortTerm + taxableLongTerm;
      const amountOverThreshold = Math.max(0, totalTaxableIncome - US_NIIT_THRESHOLD_AGOROT);
      const niitBase = Math.min(amountOverThreshold, taxableShortTerm + taxableLongTerm);
      niitTax = agorot(Math.round(niitBase * US_NIIT_RATE));
      notes.push("Includes the 3.8% Net Investment Income Tax surtax.");
    }

    const taxableGainAgorot = agorot(taxableShortTerm + taxableLongTerm);
    const taxOwedAgorot = agorot(shortTermTax + longTermTax + niitTax);
    notes.push(
      "Federal tax only (state/local capital-gains tax is not modeled); single-filer brackets assumed.",
    );

    if (dividendIncomeAgorot > 0) {
      notes.push(
        "Dividend income is reported for context only — this simulator's US model taxes capital gains alone; dividends would ordinarily be taxed as ordinary/qualified income separately, not modeled here.",
      );
    }

    return {
      jurisdiction: "US",
      shortTermGainAgorot: gains.shortTermGainAgorot,
      longTermGainAgorot: gains.longTermGainAgorot,
      flatGainAgorot: agorot(0),
      totalGainAgorot,
      dividendIncomeAgorot,
      allowanceAppliedAgorot: agorot(0),
      taxableGainAgorot,
      taxOwedAgorot,
      effectiveRate: totalGainAgorot > 0 ? taxOwedAgorot / totalGainAgorot : null,
      notes,
    };
  }

  if (profile.jurisdiction === "DE") {
    // Kapitalerträge (Abgeltungssteuer's taxable base) legally covers
    // BOTH capital gains and investment income like dividends together,
    // sharing one 25% flat rate, one Sparer-Pauschbetrag allowance, and
    // the same solidarity/church-tax add-ons — not two separate
    // calculations. `combinedTaxableBaseAgorot` (computed above, already
    // proven > 0 by this point) is that shared base.
    const allowanceApplied = agorot(Math.min(combinedTaxableBaseAgorot, Math.max(0, profile.annualAllowanceAgorot)));
    const taxableGainAgorot = subtractAgorot(combinedTaxableBaseAgorot, allowanceApplied);
    const baseTax = taxableGainAgorot * DE_FLAT_RATE;
    const solidaritySurcharge = baseTax * DE_SOLIDARITY_SURCHARGE_RATE;
    const churchTax = baseTax * Math.max(0, profile.churchTaxRate);
    const taxOwedAgorot = agorot(Math.round(baseTax + solidaritySurcharge + churchTax));

    notes.push(
      "Flat Abgeltungssteuer applies regardless of holding period (the post-2009 Neubestand rule); shares acquired before 2009 (Altbestand) are not modeled.",
    );
    notes.push(
      dividendIncomeAgorot > 0
        ? "Includes dividend income in the Kapitalerträge taxable base, taxed together with capital gains at the same flat rate and shared allowance (Kapitalertragsteuer)."
        : "No dividend income this period — Kapitalerträge here is capital gains only.",
    );
    notes.push(
      profile.churchTaxRate > 0
        ? "Includes church tax (Kirchensteuer) at the configured rate."
        : "Church tax (Kirchensteuer) not included — opt in if you're a registered member.",
    );

    return {
      jurisdiction: "DE",
      shortTermGainAgorot: agorot(0),
      longTermGainAgorot: agorot(0),
      flatGainAgorot: gains.flatGainAgorot,
      totalGainAgorot,
      dividendIncomeAgorot,
      allowanceAppliedAgorot: allowanceApplied,
      taxableGainAgorot,
      taxOwedAgorot,
      effectiveRate: combinedTaxableBaseAgorot > 0 ? taxOwedAgorot / combinedTaxableBaseAgorot : null,
      notes,
    };
  }

  // INTL: generic flat-rate/allowance model.
  const allowanceApplied = agorot(Math.min(totalGainAgorot, Math.max(0, profile.annualAllowanceAgorot)));
  const taxableGainAgorot = subtractAgorot(totalGainAgorot, allowanceApplied);
  const taxOwedAgorot = agorot(Math.round(taxableGainAgorot * Math.max(0, profile.flatRatePercent)));

  notes.push(
    "Generic flat-rate model for a jurisdiction not explicitly modeled — tune the rate/allowance for your country; holding period is not considered here.",
  );
  if (dividendIncomeAgorot > 0) {
    notes.push("Dividend income is reported for context only — not included in this generic model's taxable base.");
  }

  return {
    jurisdiction: "INTL",
    shortTermGainAgorot: agorot(0),
    longTermGainAgorot: agorot(0),
    flatGainAgorot: gains.flatGainAgorot,
    totalGainAgorot,
    dividendIncomeAgorot,
    allowanceAppliedAgorot: allowanceApplied,
    taxableGainAgorot,
    taxOwedAgorot,
    effectiveRate: totalGainAgorot > 0 ? taxOwedAgorot / totalGainAgorot : null,
    notes,
  };
}
