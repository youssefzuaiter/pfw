import "server-only";
import { cache } from "react";
import { agorot, subtractAgorot, type Agorot } from "../../lib/money";
import { nativeAmount, type CurrencyCode } from "../../lib/currency";
import { getMockInstrument, getMockPriceAgorot, isKnownMockSymbol } from "../../lib/mock-market-data";
import {
  replayTaxLots,
  holdingPeriodDays,
  type CostBasisMethod,
  type LotTradeEvent,
  type OpenTaxLot,
} from "../../lib/tax-lots";
import {
  classifyHoldingTerm,
  computeCapitalGainsTax,
  netGainsByTerm,
  DEFAULT_MARGINAL_RATE_ESTIMATE,
  type HoldingTerm,
  type TaxCalculationResult,
  type TaxJurisdiction,
  type TaxProfileInput,
} from "../../lib/tax-rules";
import {
  findHarvestCandidates,
  summarizeHarvestPotential,
  WASH_SALE_WINDOW_DAYS,
  type HarvestCandidate,
  type HarvestPotentialSummary,
} from "../../lib/tax-loss-harvesting";
import { getLatestRateTable } from "../dal/exchange-rates";
import { listPortfolioHoldings, listTrades } from "../dal/portfolio";

export type OpenLotRow = OpenTaxLot & {
  symbolName: string;
  currentPriceAgorot: Agorot;
  currentValueAgorot: Agorot;
  unrealizedGainAgorot: Agorot;
  holdingPeriodDaysValue: number;
  term: HoldingTerm;
};

export type HarvestCandidateRow = HarvestCandidate & { symbolName: string };

export type TaxSimulationData = {
  asOf: Date;
  method: CostBasisMethod;
  jurisdiction: TaxJurisdiction;
  profile: TaxProfileInput;
  /** Tax on gains already realized (sold) within the current calendar year, under the chosen method/jurisdiction. */
  realizedThisYear: TaxCalculationResult;
  /** `realizedThisYear` plus every open lot hypothetically sold today at the mock feed's current price. */
  ifLiquidatedToday: TaxCalculationResult;
  /** The marginal tax cost of liquidating everything right now, beyond what's already realized. */
  additionalTaxIfLiquidatedAgorot: Agorot;
  openLots: OpenLotRow[];
  harvestCandidates: HarvestCandidateRow[];
  harvestSummary: HarvestPotentialSummary;
};

function toClassifiedGain(gain: { realizedGainAgorot: Agorot; holdingPeriodDays: number }, jurisdiction: TaxJurisdiction) {
  return { realizedGainAgorot: gain.realizedGainAgorot, term: classifyHoldingTerm(gain.holdingPeriodDays, jurisdiction) };
}

/**
 * Assembles everything `/trading/tax` renders: replays every symbol's
 * trade history into FIFO/LIFO tax lots, simulates liability under one
 * jurisdiction's rules for gains already realized this calendar year and
 * for a full hypothetical liquidation today, and runs the tax-loss
 * harvesting radar over whatever's left open at a loss.
 *
 * Wrapped in `cache()` per-request, like every other `build-*-data.ts`
 * aggregator (AGENTS.md §3c) — per-user financial data, never a
 * cross-request cache. Arguments are primitives, not a profile object,
 * so `cache()`'s per-argument identity comparison can actually dedupe a
 * call within one request (same reasoning as `build-monte-carlo-data.ts`).
 */
export const buildTaxSimulation = cache(async function buildTaxSimulation(
  userId: string,
  method: CostBasisMethod,
  jurisdiction: TaxJurisdiction,
  otherOrdinaryIncomeAgorot: Agorot,
  includeNiit: boolean,
  churchTaxRate: number,
  annualAllowanceAgorot: Agorot,
  flatRatePercent: number,
  asOf: Date = new Date(),
): Promise<TaxSimulationData> {
  const profile: TaxProfileInput = {
    jurisdiction,
    otherOrdinaryIncomeAgorot,
    includeNiit,
    churchTaxRate,
    annualAllowanceAgorot,
    flatRatePercent,
  };

  const [holdings, trades, rateTable] = await Promise.all([
    listPortfolioHoldings(userId),
    listTrades(userId),
    getLatestRateTable(asOf),
  ]);

  const currencyBySymbol = new Map<string, CurrencyCode>(holdings.map((h) => [h.symbol, h.currency]));
  const tradesBySymbol = new Map<string, typeof trades>();
  for (const trade of trades) {
    if (!isKnownMockSymbol(trade.symbol)) continue; // defensive — every trade is placed against a mock symbol via TradeForm
    const list = tradesBySymbol.get(trade.symbol) ?? [];
    list.push(trade);
    tradesBySymbol.set(trade.symbol, list);
  }

  const taxYearStart = new Date(Date.UTC(asOf.getUTCFullYear(), 0, 1));
  const currentPriceBySymbol = new Map<string, Agorot>();
  const recentBuyDatesBySymbol = new Map<string, Date[]>();
  const washSaleWindowStart = new Date(asOf.getTime() - WASH_SALE_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const allOpenLots: OpenLotRow[] = [];
  const realizedThisYearGains: { realizedGainAgorot: Agorot; term: HoldingTerm }[] = [];
  const hypotheticalLiquidationGains: { realizedGainAgorot: Agorot; term: HoldingTerm }[] = [];

  for (const [symbol, symbolTrades] of tradesBySymbol) {
    const currency = currencyBySymbol.get(symbol) ?? symbolTrades[0].currency;
    const events: LotTradeEvent[] = symbolTrades.map((t) => ({
      side: t.side,
      quantity: t.quantity.toNumber(),
      executedAt: t.executedAt,
      priceAgorot: agorot(Number(t.priceAgorot)),
      nativePricePerShare: nativeAmount(Number(t.nativePriceAmount)),
    }));

    const { openLots, disposals } = replayTaxLots(symbol, currency, events, method);

    for (const disposal of disposals) {
      if (disposal.disposedAt.getTime() >= taxYearStart.getTime()) {
        realizedThisYearGains.push(toClassifiedGain(disposal, jurisdiction));
        hypotheticalLiquidationGains.push(toClassifiedGain(disposal, jurisdiction));
      }
    }

    const currentPriceAgorot = getMockPriceAgorot(symbol, asOf, rateTable.USD);
    currentPriceBySymbol.set(symbol, currentPriceAgorot);

    recentBuyDatesBySymbol.set(
      symbol,
      symbolTrades
        .filter((t) => t.side === "BUY" && t.executedAt.getTime() >= washSaleWindowStart.getTime())
        .map((t) => t.executedAt),
    );

    const symbolName = getMockInstrument(symbol).name;
    for (const lot of openLots) {
      const currentValueAgorot = agorot(Math.round(currentPriceAgorot * lot.quantity));
      const unrealizedGainAgorot = subtractAgorot(currentValueAgorot, lot.costBasisAgorot);
      const holdingPeriodDaysValue = holdingPeriodDays(lot.acquiredAt, asOf);

      allOpenLots.push({
        ...lot,
        symbolName,
        currentPriceAgorot,
        currentValueAgorot,
        unrealizedGainAgorot,
        holdingPeriodDaysValue,
        term: classifyHoldingTerm(holdingPeriodDaysValue, jurisdiction),
      });

      hypotheticalLiquidationGains.push({
        realizedGainAgorot: unrealizedGainAgorot,
        term: classifyHoldingTerm(holdingPeriodDaysValue, jurisdiction),
      });
    }
  }

  const realizedThisYear = computeCapitalGainsTax(profile, netGainsByTerm(realizedThisYearGains));
  const ifLiquidatedToday = computeCapitalGainsTax(profile, netGainsByTerm(hypotheticalLiquidationGains));
  const additionalTaxIfLiquidatedAgorot = subtractAgorot(ifLiquidatedToday.taxOwedAgorot, realizedThisYear.taxOwedAgorot);

  // Harvesting's blended marginal-rate estimate: tax attributable to
  // positions currently sitting at a GAIN (the thing a harvested loss
  // would actually offset), spread evenly across that gain — falling back
  // to a jurisdiction-representative constant when there's no positive
  // unrealized gain yet to derive an empirical rate from at all.
  const positiveGains = hypotheticalLiquidationGains.filter((g) => g.realizedGainAgorot > 0);
  const positiveGainsTotal = positiveGains.reduce((sum, g) => sum + g.realizedGainAgorot, 0);
  const taxOnPositiveGains = computeCapitalGainsTax(profile, netGainsByTerm(positiveGains)).taxOwedAgorot;
  const fallbackRate = jurisdiction === "INTL" ? flatRatePercent : DEFAULT_MARGINAL_RATE_ESTIMATE[jurisdiction];
  const blendedMarginalRate = positiveGainsTotal > 0 ? taxOnPositiveGains / positiveGainsTotal : fallbackRate;

  const harvestCandidates = findHarvestCandidates(
    allOpenLots,
    currentPriceBySymbol,
    recentBuyDatesBySymbol,
    blendedMarginalRate,
    asOf,
  ).map((candidate) => ({ ...candidate, symbolName: getMockInstrument(candidate.symbol).name }));

  return {
    asOf,
    method,
    jurisdiction,
    profile,
    realizedThisYear,
    ifLiquidatedToday,
    additionalTaxIfLiquidatedAgorot,
    openLots: allOpenLots.sort((a, b) => b.currentValueAgorot - a.currentValueAgorot),
    harvestCandidates,
    harvestSummary: summarizeHarvestPotential(harvestCandidates),
  };
});

function serializeAgorot(value: Agorot) {
  return { agorot: Number(value) };
}

function serializeTaxResult(result: TaxCalculationResult) {
  return {
    shortTermGain: serializeAgorot(result.shortTermGainAgorot),
    longTermGain: serializeAgorot(result.longTermGainAgorot),
    flatGain: serializeAgorot(result.flatGainAgorot),
    totalGain: serializeAgorot(result.totalGainAgorot),
    allowanceApplied: serializeAgorot(result.allowanceAppliedAgorot),
    taxableGain: serializeAgorot(result.taxableGainAgorot),
    taxOwed: serializeAgorot(result.taxOwedAgorot),
    effectiveRate: result.effectiveRate,
    notes: result.notes,
  };
}

/**
 * The one place `TaxSimulationData` becomes the JSON shape both
 * `GET /api/tax/simulate` and `/trading/tax/page.tsx`'s first
 * server-rendered paint send to the client widget — kept in one function
 * so the two call sites can't drift into two different response shapes,
 * same pattern as `serializeMonteCarloAnalytics`.
 */
export function serializeTaxSimulation(data: TaxSimulationData) {
  return {
    ok: true as const,
    asOf: data.asOf.toISOString(),
    method: data.method,
    jurisdiction: data.jurisdiction,
    profile: {
      otherOrdinaryIncome: serializeAgorot(data.profile.otherOrdinaryIncomeAgorot),
      includeNiit: data.profile.includeNiit,
      churchTaxRate: data.profile.churchTaxRate,
      annualAllowance: serializeAgorot(data.profile.annualAllowanceAgorot),
      flatRatePercent: data.profile.flatRatePercent,
    },
    realizedThisYear: serializeTaxResult(data.realizedThisYear),
    ifLiquidatedToday: serializeTaxResult(data.ifLiquidatedToday),
    additionalTaxIfLiquidated: serializeAgorot(data.additionalTaxIfLiquidatedAgorot),
    openLots: data.openLots.map((lot) => ({
      symbol: lot.symbol,
      symbolName: lot.symbolName,
      acquiredAt: lot.acquiredAt.toISOString(),
      quantity: lot.quantity,
      costBasis: serializeAgorot(lot.costBasisAgorot),
      currentValue: serializeAgorot(lot.currentValueAgorot),
      unrealizedGain: serializeAgorot(lot.unrealizedGainAgorot),
      holdingPeriodDays: lot.holdingPeriodDaysValue,
      term: lot.term,
    })),
    harvestCandidates: data.harvestCandidates.map((c) => ({
      symbol: c.symbol,
      symbolName: c.symbolName,
      acquiredAt: c.acquiredAt.toISOString(),
      quantity: c.quantity,
      costBasis: serializeAgorot(c.costBasisAgorot),
      currentValue: serializeAgorot(c.currentValueAgorot),
      unrealizedLoss: serializeAgorot(c.unrealizedLossAgorot),
      holdingPeriodDays: c.holdingPeriodDays,
      washSaleRisk: c.washSaleRisk,
      estimatedTaxSavings: serializeAgorot(c.estimatedTaxSavingsAgorot),
    })),
    harvestSummary: {
      totalHarvestableLoss: serializeAgorot(data.harvestSummary.totalHarvestableLossAgorot),
      totalEstimatedTaxSavings: serializeAgorot(data.harvestSummary.totalEstimatedTaxSavingsAgorot),
      washSaleFlaggedCount: data.harvestSummary.washSaleFlaggedCount,
    },
  };
}

export type TaxSimulationResponse = ReturnType<typeof serializeTaxSimulation>;
