import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import { computeLiveNetWorth } from "../../src/server/dal/net-worth";
import { buildLiquidityRunwayData } from "../../src/server/analytics/build-liquidity-runway-data";

/**
 * Integration coverage for the Real-Time Liquidity Runway & Burn-Rate
 * Engine's server-side wiring (AGENTS.md §3v) — the pure math
 * (`src/lib/liquidity-classification.ts`, `burn-rate.ts`,
 * `liquidity-runway.ts`) already has thorough unit coverage; what this
 * suite proves is that `computeLiveNetWorth`'s new `liquidity` field and
 * `buildLiquidityRunwayData` correctly classify REAL Prisma rows (with
 * their actual `BigInt`/enum shapes) against a real Postgres database
 * with RLS active, and that the whole pipeline is genuinely IDOR-safe.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("Liquidity Runway & Burn-Rate Engine", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let userA: { id: string };
  let userB: { id: string };

  beforeAll(async () => {
    admin = createAdminClient();
    userA = await admin.user.create({
      data: { email: `liquidity-runway-test-a-${Date.now()}@pfw.local`, displayName: "Runway Test A" },
    });
    userB = await admin.user.create({
      data: { email: `liquidity-runway-test-b-${Date.now()}@pfw.local`, displayName: "Runway Test B" },
    });

    await admin.bankAccount.create({
      data: { userId: userA.id, institutionName: "Test Bank", last4: "1111", accountType: "CHECKING", nativeBalance: 500_000n },
    });
    await admin.bankAccount.create({
      data: { userId: userA.id, institutionName: "Test Bank", last4: "2222", accountType: "SAVINGS", nativeBalance: 1_000_000n },
    });
    // A credit-card balance must NOT appear anywhere in the liquidity breakdown.
    await admin.bankAccount.create({
      data: { userId: userA.id, institutionName: "Test Bank", last4: "3333", accountType: "CREDIT_CARD", nativeBalance: 200_000n },
    });
    await admin.manualAsset.create({
      data: { userId: userA.id, name: "Apartment", assetType: "PROPERTY", currentValue: 900_000_000n, valuedAt: new Date() },
    });
    await admin.manualAsset.create({
      data: {
        userId: userA.id,
        name: "Overridden Collectible",
        assetType: "OTHER", // defaults to ILLIQUID
        currentValue: 40_000n,
        valuedAt: new Date(),
        liquidityTier: "SEMI_LIQUID", // explicit override
      },
    });
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
    await admin.$disconnect();
  });

  it("computeLiveNetWorth classifies real rows into the correct liquidity buckets", async () => {
    const netWorth = await computeLiveNetWorth(userA.id);

    expect(netWorth.liquidity.liquidAgorot).toBe(1_500_000); // checking + savings, credit card excluded
    expect(netWorth.liquidity.illiquidAgorot).toBe(900_000_000); // the apartment only (the OTHER asset was overridden away)
    expect(netWorth.liquidity.semiLiquidAgorot).toBe(40_000); // the overridden collectible, no portfolio holdings in this fixture
  });

  it("does not leak user A's liquidity classification into user B's net worth (IDOR)", async () => {
    const netWorthB = await computeLiveNetWorth(userB.id);
    expect(netWorthB.liquidity).toEqual({ liquidAgorot: 0, semiLiquidAgorot: 0, illiquidAgorot: 0 });
  });

  it("buildLiquidityRunwayData assembles a coherent end-to-end result for a real account", async () => {
    const data = await buildLiquidityRunwayData(userA.id);

    expect(data.breakdown.liquidAgorot).toBe(1_500_000);
    expect(data.runway.availableAgorot).toBe(1_500_000 + 40_000); // liquid + semi-liquid, illiquid excluded
    // No transaction history and no active subscriptions in this fixture -> zero burn -> infinite runway.
    expect(data.burnRate.monthlyBurnRateAgorot).toBe(0);
    expect(data.burnRate.source).toBe("none");
    expect(data.runway.runwayDays).toBeNull();
  });

  it("a real recurring subscription raises the burn-rate floor and produces a finite runway", async () => {
    const account = await admin.bankAccount.create({
      data: { userId: userB.id, institutionName: "Test Bank", last4: "4444", accountType: "CHECKING", nativeBalance: 300_000n },
    });
    const category = await admin.category.create({ data: { userId: userB.id, slug: "entertainment", name: "Entertainment" } });

    // Three monthly occurrences of the same recurring charge — enough for
    // the subscription radar to classify it as an active monthly subscription.
    for (let i = 0; i < 3; i++) {
      const occurredAt = new Date();
      occurredAt.setUTCMonth(occurredAt.getUTCMonth() - i);
      await admin.notableTransaction.create({
        data: {
          userId: userB.id,
          bankAccountId: account.id,
          categoryId: category.id,
          occurredAt,
          currency: "ILS",
          nativeAmount: -3990n,
          amount: -3990n,
          description: "Streaming Service",
          merchantName: "Streaming Service",
        },
      });
    }

    const data = await buildLiquidityRunwayData(userB.id);
    expect(data.burnRate.monthlyBurnRateAgorot).toBeGreaterThan(0);
    expect(data.runway.availableAgorot).toBe(300_000);
    expect(data.runway.runwayDays).not.toBeNull();
    expect(data.runway.runwayDays).toBeGreaterThan(0);
  });
});
