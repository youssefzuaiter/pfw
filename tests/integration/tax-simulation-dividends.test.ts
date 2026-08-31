import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agorot } from "../../src/lib/money";
import { DE_DEFAULT_ANNUAL_ALLOWANCE_AGOROT } from "../../src/lib/tax-rules";
import { createAdminClient } from "../../src/server/db/admin-client";
import { buildTaxSimulation } from "../../src/server/tax/build-tax-data";

/**
 * Integration coverage for the German tax simulator's Kapitalerträge
 * fix (Punch List Phase 3, item 1, amending AGENTS.md §3r): proves the
 * real DAL wiring (`buildTaxSimulation` fetching real `Trade`/`Dividend`
 * rows through `dal/portfolio.ts`/`dal/dividends.ts`) actually folds real
 * PAID dividend income into the DE taxable base, not just the
 * `tax-rules.ts` unit-level math in isolation. Skipped without a live
 * DB, same convention as every other integration test.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)(
  "German tax simulator: dividend income in the Kapitalerträge base",
  () => {
    let admin: ReturnType<typeof createAdminClient>;
    let user: { id: string };
    let holding: { id: string };

    const asOf = new Date(Date.UTC(2026, 5, 15)); // well into the mock "current" tax year
    const taxYearStart = new Date(Date.UTC(2026, 0, 1));

    beforeAll(async () => {
      admin = createAdminClient();
      user = await admin.user.create({
        data: { email: `de-tax-dividends-${Date.now()}@pfw.local`, displayName: "DE Tax Dividends Test" },
      });

      holding = await admin.portfolioHolding.create({
        data: {
          userId: user.id,
          symbol: "AAPL",
          assetClass: "STOCK",
          quantity: "10",
          currency: "USD",
          totalCostBasis: 500_000n,
          nativeCostBasis: 135_000n,
        },
      });

      // A single open BUY lot — no SELLs this year, so realized CAPITAL
      // GAINS this year are exactly zero; any tax owed on
      // `realizedThisYear` must come entirely from dividend income.
      await admin.trade.create({
        data: {
          userId: user.id,
          portfolioHoldingId: holding.id,
          symbol: "AAPL",
          side: "BUY",
          quantity: "10",
          currency: "USD",
          priceAgorot: 50_000n,
          totalAgorot: 500_000n,
          nativePriceAmount: 13_500n,
          nativeTotalAmount: 135_000n,
          exchangeRateAtEntry: "3.7",
          executedAt: new Date(Date.UTC(2025, 5, 1)), // acquired last year, well before this tax year
        },
      });

      // A real PAID dividend, received within the simulated tax year.
      await admin.dividend.create({
        data: {
          userId: user.id,
          portfolioHoldingId: holding.id,
          symbol: "AAPL",
          currency: "USD",
          amountPerShareNative: 25n,
          exDate: new Date(Date.UTC(2026, 2, 1)),
          payDate: new Date(Date.UTC(2026, 2, 15)),
          status: "PAID",
          quantityAtPayment: "10",
          totalNativeAmount: 250n,
          totalAgorot: 925n, // 250 cents * 3.7
          exchangeRateAtEntry: "3.7",
        },
      });
    });

    afterAll(async () => {
      await admin.user.deleteMany({ where: { id: user.id } });
      await admin.$disconnect();
    });

    it("dividendIncomeThisYearAgorot reflects the real PAID dividend row, not zero", async () => {
      const data = await buildTaxSimulation(
        user.id,
        "FIFO",
        "DE",
        agorot(0),
        false,
        0,
        DE_DEFAULT_ANNUAL_ALLOWANCE_AGOROT,
        0.2,
        asOf,
      );
      expect(data.dividendIncomeThisYearAgorot).toBe(925);
    });

    it("owes real tax on dividend income under DE even though realized capital gains this year are exactly zero", async () => {
      const data = await buildTaxSimulation(
        user.id,
        "FIFO",
        "DE",
        agorot(0),
        false,
        0,
        agorot(0), // zero allowance, so the math is exact and not obscured by the default allowance absorbing everything
        0.2,
        asOf,
      );

      expect(data.realizedThisYear.totalGainAgorot).toBe(0); // no sells this year
      expect(data.realizedThisYear.dividendIncomeAgorot).toBe(925);
      // 925 * 25% = 231.25 -> rounds to 231; + 5.5% soli (12.705 -> 13) = 244,
      // matching computeCapitalGainsTax's own rounding (Math.round on the summed total).
      expect(data.realizedThisYear.taxableGainAgorot).toBe(925);
      expect(data.realizedThisYear.taxOwedAgorot).toBeGreaterThan(0);
      expect(data.realizedThisYear.taxOwedAgorot).toBe(agorot(Math.round(925 * 0.25 * 1.055)));
    });

    it("US jurisdiction reports the same real dividend figure for context but never taxes it", async () => {
      const data = await buildTaxSimulation(user.id, "FIFO", "US", agorot(0), false, 0, agorot(0), 0.2, asOf);
      expect(data.dividendIncomeThisYearAgorot).toBe(925);
      expect(data.realizedThisYear.dividendIncomeAgorot).toBe(925);
      expect(data.realizedThisYear.taxOwedAgorot).toBe(0); // no realized US gains, dividends not taxed here
    });

    it("dividendIncomeThisYearAgorot only counts dividends actually paid within the simulated tax year window", async () => {
      const lastYearAsOf = new Date(Date.UTC(2025, 11, 31));
      const data = await buildTaxSimulation(
        user.id,
        "FIFO",
        "DE",
        agorot(0),
        false,
        0,
        DE_DEFAULT_ANNUAL_ALLOWANCE_AGOROT,
        0.2,
        lastYearAsOf,
      );
      // The seeded dividend was paid 2026-03-15 — outside a simulation
      // anchored at end-of-2025, so it must not be counted.
      expect(data.dividendIncomeThisYearAgorot).toBe(0);
    });
  },
);
