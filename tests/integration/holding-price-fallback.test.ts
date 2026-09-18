import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import { computeLiveNetWorth } from "../../src/server/dal/net-worth";
import { resolveHoldingPrices } from "../../src/server/dal/portfolio";
import { buildPortfolioData } from "../../src/server/portfolio/build-portfolio-data";
import { getLatestRateTable } from "../../src/server/dal/exchange-rates";
import { getMockPriceAgorot } from "../../src/lib/mock-market-data";
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

  // 0.174192544 TSLA filled at $362.25 — the real shape of the live trade
  // that surfaced this, down to the fractional quantity.
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
        symbol: "TSLA",
        assetClass: "STOCK",
        quantity: TSLA_QTY,
        totalCostBasis: 22_085n,
        nativeCostBasis: 6_310n,
      },
    });
    const baseTrade = {
      userId: userA.id,
      portfolioHoldingId: tsla.id,
      symbol: "TSLA",
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

    // User B holds TSLA too, with its own (different) fill — A's price must
    // never be read from B's trade history.
    const tslaB = await admin.portfolioHolding.create({
      data: { userId: userB.id, symbol: "TSLA", assetClass: "STOCK", quantity: 1, totalCostBasis: 100_000n, nativeCostBasis: 30_000n },
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
    await admin.$disconnect();
  });

  it("prices an unknown symbol at this user's newest non-cancelled fill, a seeded one from the feed, an untraded one at cost", async () => {
    const holdings = await admin.portfolioHolding.findMany({ where: { userId: userA.id } });
    const rateTable = await getLatestRateTable(asOf);
    const prices = await resolveHoldingPrices(userA.id, holdings, asOf, rateTable.USD);

    expect(prices.get("TSLA")).toEqual({
      priceAgorot: agorot(Number(TSLA_FILL_AGOROT)),
      nativePrice: Number(TSLA_FILL_NATIVE),
      source: "last_fill",
    });
    expect(prices.get("MSFT")).toMatchObject({ source: "mock_feed", priceAgorot: getMockPriceAgorot("MSFT", asOf, rateTable.USD) });
    expect(prices.get("NFLX")).toEqual({ priceAgorot: agorot(100_000), nativePrice: 30_000, source: "cost_basis" });
  });

  it("never reads another user's fills (user B's TSLA trade does not price user A's holding)", async () => {
    const holdingsB = await admin.portfolioHolding.findMany({ where: { userId: userB.id } });
    const rateTable = await getLatestRateTable(asOf);
    const pricesB = await resolveHoldingPrices(userB.id, holdingsB, asOf, rateTable.USD);
    expect(pricesB.get("TSLA")?.priceAgorot).toBe(agorot(555_555));

    const holdingsA = await admin.portfolioHolding.findMany({ where: { userId: userA.id, symbol: "TSLA" } });
    const pricesA = await resolveHoldingPrices(userA.id, holdingsA, asOf, rateTable.USD);
    expect(pricesA.get("TSLA")?.priceAgorot).toBe(agorot(Number(TSLA_FILL_AGOROT)));
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
    const tsla = data.rows.find((row) => row.symbol === "TSLA");
    const msft = data.rows.find((row) => row.symbol === "MSFT");
    const nflx = data.rows.find((row) => row.symbol === "NFLX");

    expect(tsla).toMatchObject({ name: "TSLA", priceSource: "last_fill" });
    expect(tsla?.marketValue).toBe(multiplyAgorot(agorot(Number(TSLA_FILL_AGOROT)), TSLA_QTY));
    expect(msft).toMatchObject({ name: "Microsoft Corp.", priceSource: "mock_feed" });
    // Valued at cost ⇒ no unrealized gain or loss, by construction.
    expect(nflx).toMatchObject({ name: "NFLX", priceSource: "cost_basis", unrealizedGain: 0 });
  });
});
