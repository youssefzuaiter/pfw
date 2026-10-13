import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import { listEquityQuoteHistory } from "../../src/server/dal/equity-quotes";

/**
 * The benchmark line's price history read (AGENTS.md §3mmm) against real
 * Postgres. `EquityQuote` is a global table every suite shares, so this uses
 * a ticker no real sync will ever quote and deletes only its own rows (the
 * §3xx lesson: a real TSLA quote once broke a suite that used "TSLA").
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("benchmark quote history", () => {
  const SYMBOL = "VTZQ";
  let admin: ReturnType<typeof createAdminClient>;

  beforeAll(async () => {
    admin = createAdminClient();
    await admin.equityQuote.deleteMany({ where: { symbol: SYMBOL } });
    for (const [asOf, observed, price] of [
      ["2026-10-08", "2026-10-07T19:59:00Z", "118.10"],
      ["2026-10-09", "2026-10-08T19:59:00Z", "119.20"],
      ["2026-10-10", "2026-10-09T19:59:00Z", "120.30"],
    ] as const) {
      await admin.equityQuote.create({
        data: { symbol: SYMBOL, priceUsd: price, asOfDate: new Date(`${asOf}T00:00:00Z`), observedAt: new Date(observed), source: "test" },
      });
    }
  });

  afterAll(async () => {
    await admin.equityQuote.deleteMany({ where: { symbol: SYMBOL, source: "test" } });
    await admin.$disconnect();
  });

  it("returns the prices observed since the cutoff, oldest first, as numbers", async () => {
    const rows = await listEquityQuoteHistory(SYMBOL.toLowerCase(), new Date("2026-10-08T00:00:00Z"));
    expect(rows).toEqual([
      { observedAt: new Date("2026-10-08T19:59:00Z"), priceUsd: 119.2 },
      { observedAt: new Date("2026-10-09T19:59:00Z"), priceUsd: 120.3 },
    ]);
  });

  it("is an empty history, not an error, for a symbol never quoted", async () => {
    expect(await listEquityQuoteHistory("NOSUCHQ", new Date(0))).toEqual([]);
  });
});
