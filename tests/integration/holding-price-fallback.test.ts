import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import { computeLiveNetWorth } from "../../src/server/dal/net-worth";
import { resolveHoldingPrices } from "../../src/server/dal/portfolio";
import { buildPortfolioData } from "../../src/server/portfolio/build-portfolio-data";
import { getLatestRateTable } from "../../src/server/dal/exchange-rates";
import { getMockPriceAgorot } from "../../src/lib/mock-market-data";
import { convertNativeAmountToAgorot } from "../../src/lib/exchange-rate";
import { nativeAmount } from "../../src/lib/currency";
import { getLatestEquityQuotes, upsertEquityQuote } from "../../src/server/dal/equity-quotes";
import { syncEquityQuotes } from "../../src/server/market-data/quote-sync";
import { agorot, multiplyAgorot } from "../../src/lib/money";

/**
 * The paper trader books REAL Alpaca fills for whatever ticker a headline
 * names, and the mock price feed only knows the 10 seeded instruments —
 * so one TSLA position took `/dashboard`, `/trading/portfolio` and the
 * advisor's holdings tool down for the trading account on every load
 * (`RangeError: Unknown mock symbol: TSLA` out of `computeLiveNetWorth`,
 * found live). These cases reproduce that exact shape against real
 * Postgres rows — a holding whose symbol the feed can't price, with and
 * without a fill on record — and pin the fallback chain
 * (`src/lib/holding-price.ts`) plus its user scoping.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("holding prices outside the mock universe", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let userA: { id: string };
  let userB: { id: string };
  const asOf = new Date();

  // 0.174192544 sh filled at $362.25 — the real shape of the live TSLA
  // trade that surfaced this, down to the fractional quantity. The ticker
  // itself is synthetic ("TSLX"): `EquityQuote` is a global table, and a
  // real `npm run sync:quotes` stores a real TSLA quote that would — and
  // once did — silently win over this suite's fake fill.
  const TSLA_QTY = 0.174192544;
  const TSLA_FILL_NATIVE = 36_225n;
  const TSLA_FILL_AGOROT = 126_788n;
  // An older, higher fill — must NOT win over the newest one.
  const TSLA_OLD_FILL_AGOROT = 140_000n;
  // A cancelled order at a wild price — must never be used.
  const TSLA_CANCELED_AGOROT = 999_999n;

  beforeAll(async () => {
    admin = createAdminClient();
    const stamp = Date.now();
    userA = await admin.user.create({
      data: { email: `holding-price-a-${stamp}@pfw.local`, displayName: "Holding Price A" },
    });
    userB = await admin.user.create({
      data: { email: `holding-price-b-${stamp}@pfw.local`, displayName: "Holding Price B" },
    });

    const tsla = await admin.portfolioHolding.create({
      data: {
        userId: userA.id,
        symbol: "TSLX",
        assetClass: "STOCK",
        quantity: TSLA_QTY,
        totalCostBasis: 22_085n,
        nativeCostBasis: 6_310n,
      },
    });
    const baseTrade = {
      userId: userA.id,
      portfolioHoldingId: tsla.id,
      symbol: "TSLX",
      side: "BUY" as const,
      quantity: TSLA_QTY,
      currency: "USD" as const,
      nativePriceAmount: TSLA_FILL_NATIVE,
      nativeTotalAmount: 6_310n,
      totalAgorot: 22_085n,
      exchangeRateAtEntry: 3.5,
    };
    await admin.trade.create({
      data: { ...baseTrade, priceAgorot: TSLA_OLD_FILL_AGOROT, executedAt: new Date(asOf.getTime() - 2 * 86_400_000), status: "SETTLED" },
    });
    await admin.trade.create({
      data: { ...baseTrade, priceAgorot: TSLA_FILL_AGOROT, executedAt: new Date(asOf.getTime() - 86_400_000), status: "SETTLED" },
    });
    await admin.trade.create({
      data: { ...baseTrade, priceAgorot: TSLA_CANCELED_AGOROT, executedAt: asOf, status: "CANCELED" },
    });

    // A seeded instrument alongside it — must still come from the mock feed.
    await admin.portfolioHolding.create({
      data: { userId: userA.id, symbol: "MSFT", assetClass: "STOCK", quantity: 2, totalCostBasis: 280_000n, nativeCostBasis: 80_000n },
    });
    // A never-traded unknown symbol (no Trade row at all) — average cost.
    await admin.portfolioHolding.create({
      data: { userId: userA.id, symbol: "NFLX", assetClass: "STOCK", quantity: 4, totalCostBasis: 400_000n, nativeCostBasis: 120_000n },
    });

    // User B holds TSLX too, with its own (different) fill — A's price must
    // never be read from B's trade history.
    const tslaB = await admin.portfolioHolding.create({
      data: { userId: userB.id, symbol: "TSLX", assetClass: "STOCK", quantity: 1, totalCostBasis: 100_000n, nativeCostBasis: 30_000n },
    });
    await admin.trade.create({
      data: {
        ...baseTrade,
        userId: userB.id,
        portfolioHoldingId: tslaB.id,
        quantity: 1,
        priceAgorot: 555_555n,
        executedAt: asOf,
        status: "SETTLED",
      },
    });
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
    // Only this suite's rows — a real TSLA quote synced by `npm run sync:quotes` stays.
    await admin.equityQuote.deleteMany({ where: { OR: [{ symbol: "TSLX", source: "test" }, { symbol: "NFLX" }] } });
    await admin.$disconnect();
  });

  it("prices an unknown symbol at this user's newest non-cancelled fill, a seeded one from the feed, an untraded one at cost", async () => {
    const holdings = await admin.portfolioHolding.findMany({ where: { userId: userA.id } });
    const rateTable = await getLatestRateTable(asOf);
    const prices = await resolveHoldingPrices(userA.id, holdings, asOf, rateTable.USD);

    expect(prices.get("TSLX")).toEqual({
      priceAgorot: agorot(Number(TSLA_FILL_AGOROT)),
      nativePrice: Number(TSLA_FILL_NATIVE),
      source: "last_fill",
      observedAt: new Date(asOf.getTime() - 86_400_000),
    });
    expect(prices.get("MSFT")).toMatchObject({ source: "mock_feed", priceAgorot: getMockPriceAgorot("MSFT", asOf, rateTable.USD), observedAt: null });
    expect(prices.get("NFLX")).toEqual({ priceAgorot: agorot(100_000), nativePrice: 30_000, source: "cost_basis", observedAt: null });
  });

  it("never reads another user's fills (user B's TSLX trade does not price user A's holding)", async () => {
    const holdingsB = await admin.portfolioHolding.findMany({ where: { userId: userB.id } });
    const rateTable = await getLatestRateTable(asOf);
    const pricesB = await resolveHoldingPrices(userB.id, holdingsB, asOf, rateTable.USD);
    expect(pricesB.get("TSLX")?.priceAgorot).toBe(agorot(555_555));

    const holdingsA = await admin.portfolioHolding.findMany({ where: { userId: userA.id, symbol: "TSLX" } });
    const pricesA = await resolveHoldingPrices(userA.id, holdingsA, asOf, rateTable.USD);
    expect(pricesA.get("TSLX")?.priceAgorot).toBe(agorot(Number(TSLA_FILL_AGOROT)));
  });

  it("computeLiveNetWorth no longer throws on the unknown symbol and values it at the last fill", async () => {
    const rateTable = await getLatestRateTable(asOf);
    const netWorth = await computeLiveNetWorth(userA.id, asOf);

    const expectedPortfolio =
      multiplyAgorot(agorot(Number(TSLA_FILL_AGOROT)), TSLA_QTY) +
      multiplyAgorot(getMockPriceAgorot("MSFT", asOf, rateTable.USD), 2) +
      multiplyAgorot(agorot(100_000), 4);
    expect(netWorth.breakdown.portfolio).toBe(expectedPortfolio);
  });

  it("buildPortfolioData renders the unknown symbol as its own name and labels the price source", async () => {
    const data = await buildPortfolioData(userA.id, asOf);
    const tsla = data.rows.find((row) => row.symbol === "TSLX");
    const msft = data.rows.find((row) => row.symbol === "MSFT");
    const nflx = data.rows.find((row) => row.symbol === "NFLX");

    expect(tsla).toMatchObject({ name: "TSLX", priceSource: "last_fill" });
    expect(tsla?.marketValue).toBe(multiplyAgorot(agorot(Number(TSLA_FILL_AGOROT)), TSLA_QTY));
    expect(msft).toMatchObject({ name: "Microsoft Corp.", priceSource: "mock_feed" });
    // Valued at cost ⇒ no unrealized gain or loss, by construction.
    expect(nflx).toMatchObject({ name: "NFLX", priceSource: "cost_basis", unrealizedGain: 0 });
  });

  it("a stored market quote NEWER than the last fill wins, and one OLDER than it loses", async () => {
    const rateTable = await getLatestRateTable(asOf);
    const holdings = await admin.portfolioHolding.findMany({ where: { userId: userA.id, symbol: "TSLX" } });

    // Older than yesterday's fill → the fill still wins.
    await upsertEquityQuote({ symbol: "TSLX", priceUsd: 300, observedAt: new Date(asOf.getTime() - 3 * 86_400_000), asOfDate: new Date(Date.UTC(2020, 0, 1)), source: "test" });
    const stale = await resolveHoldingPrices(userA.id, holdings, asOf, rateTable.USD);
    expect(stale.get("TSLX")?.source).toBe("last_fill");

    // Newer than the fill → the quote wins, converted at the FX rate.
    await upsertEquityQuote({ symbol: "TSLX", priceUsd: 370.5, observedAt: asOf, asOfDate: new Date(Date.UTC(2020, 0, 2)), source: "test" });
    const fresh = await resolveHoldingPrices(userA.id, holdings, asOf, rateTable.USD);
    expect(fresh.get("TSLX")).toEqual({
      priceAgorot: convertNativeAmountToAgorot(nativeAmount(37_050), "USD", rateTable.USD),
      nativePrice: nativeAmount(37_050),
      source: "quote",
      observedAt: asOf,
    });

    // And the whole net-worth figure follows the same rule.
    const netWorth = await computeLiveNetWorth(userA.id, asOf);
    const expectedPortfolio =
      multiplyAgorot(convertNativeAmountToAgorot(nativeAmount(37_050), "USD", rateTable.USD), TSLA_QTY) +
      multiplyAgorot(getMockPriceAgorot("MSFT", asOf, rateTable.USD), 2) +
      multiplyAgorot(agorot(100_000), 4);
    expect(netWorth.breakdown.portfolio).toBe(expectedPortfolio);
  });

  it("syncEquityQuotes asks the trader only for held symbols outside the mock universe and stores what it answers", async () => {
    process.env.WEBHOOK_SECRET ??= "integration-test-webhook-secret";
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { symbols: string[] };
      // Every seeded symbol must have been filtered out before the request.
      expect(body.symbols).not.toContain("MSFT");
      expect(body.symbols).toEqual(expect.arrayContaining(["TSLX", "NFLX"]));
      return new Response(
        JSON.stringify({ quotes: { NFLX: { price: "701.10", timestamp: asOf.toISOString() } }, missing: ["TSLX"], feed: "iex" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await syncEquityQuotes(fetchImpl as typeof fetch);
    expect(result.ok).toBe(true);
    expect(result.synced).toEqual(["NFLX"]);
    expect(result.skipped).toContain("TSLX");

    const stored = await getLatestEquityQuotes(["NFLX"]);
    expect(stored.get("NFLX")).toMatchObject({ priceUsd: 701.1, observedAt: asOf });

    // The previously cost-basis NFLX position is now valued at the quote.
    const holdings = await admin.portfolioHolding.findMany({ where: { userId: userA.id, symbol: "NFLX" } });
    const rateTable = await getLatestRateTable(asOf);
    const prices = await resolveHoldingPrices(userA.id, holdings, asOf, rateTable.USD);
    expect(prices.get("NFLX")?.source).toBe("quote");
  });

  it("a trader outage is a reported failure, never a throw — holdings keep their previous valuation", async () => {
    const result = await syncEquityQuotes((async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ECONNREFUSED/);
  });
});

