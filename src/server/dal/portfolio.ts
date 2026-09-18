import "server-only";
import { multiplyAgorot, agorot, type Agorot } from "../../lib/money";
import { multiplyNativeAmount, nativeAmount, type CurrencyCode, type NativeAmount } from "../../lib/currency";
import { applyBuy, applySell, type HoldingPosition } from "../../lib/portfolio-math";
import { isKnownMockSymbol } from "../../lib/mock-market-data";
import {
  resolveHoldingPrices as resolveHoldingPricesPure,
  type LastFillPrice,
  type PricableHolding,
  type ResolvedHoldingPrice,
} from "../../lib/holding-price";
import { withUserScope, type ScopedTransactionClient } from "../db/with-user-scope";

export async function listPortfolioHoldings(userId: string) {
  return withUserScope(userId, (tx) => tx.portfolioHolding.findMany({ where: { userId }, orderBy: { symbol: "asc" } }));
}

export async function getPortfolioHoldingBySymbol(userId: string, symbol: string) {
  return withUserScope(userId, (tx) => tx.portfolioHolding.findFirst({ where: { userId, symbol } }));
}

export async function listTrades(userId: string) {
  return withUserScope(userId, (tx) => tx.trade.findMany({ where: { userId }, orderBy: { executedAt: "desc" } }));
}

/** The subset of a `PortfolioHolding` row the price resolver needs. */
export type PricableHoldingRow = {
  symbol: string;
  quantity: { toNumber(): number };
  totalCostBasis: bigint;
  nativeCostBasis: bigint;
};

function toPricableHolding(row: PricableHoldingRow): PricableHolding {
  return {
    symbol: row.symbol,
    quantity: row.quantity.toNumber(),
    totalCostBasis: agorot(Number(row.totalCostBasis)),
    nativeCostBasis: nativeAmount(Number(row.nativeCostBasis)),
  };
}

/**
 * This user's most recent non-cancelled fill per symbol, for the symbols
 * the mock feed can't price — a paper-trader fill for a ticker the mock
 * universe never had (the bug that took `/dashboard` down for the
 * trading account; see `src/lib/holding-price.ts`). Seeded symbols are
 * filtered out first, so the common all-seeded portfolio costs ZERO
 * extra queries. Rate-independent on purpose: `computeLiveNetWorth`
 * runs this inside its scoped transaction in parallel with the FX-rate
 * read, and prices afterwards.
 */
export async function findLastFillPricesInTransaction(
  tx: ScopedTransactionClient,
  userId: string,
  symbols: readonly string[],
): Promise<Map<string, LastFillPrice>> {
  const unknownSymbols = symbols.filter((symbol) => !isKnownMockSymbol(symbol));
  if (unknownSymbols.length === 0) return new Map();

  // `distinct` + `orderBy executedAt desc` = the newest fill per symbol.
  const fills = await tx.trade.findMany({
    where: { userId, symbol: { in: unknownSymbols }, status: { not: "CANCELED" } },
    orderBy: { executedAt: "desc" },
    distinct: ["symbol"],
    select: { symbol: true, priceAgorot: true, nativePriceAmount: true },
  });
  return new Map(
    fills.map((fill) => [
      fill.symbol,
      { priceAgorot: agorot(Number(fill.priceAgorot)), nativePrice: nativeAmount(Number(fill.nativePriceAmount)) },
    ]),
  );
}

/**
 * Per-share prices for a set of holding rows, keyed by symbol — the ONE
 * way a holding gets valued anywhere in this app (`computeLiveNetWorth`,
 * the dashboard's concentration insight, `/trading/portfolio`, the
 * advisor's holdings tool). Seeded instruments come from the mock feed;
 * anything else is priced at this user's last fill, or at average cost
 * when no fill exists — and the result says which (`source`).
 */
export function priceHoldingRows(
  holdings: readonly PricableHoldingRow[],
  lastFillBySymbol: ReadonlyMap<string, LastFillPrice>,
  asOf: Date,
  usdToIlsRate: number,
): Map<string, ResolvedHoldingPrice> {
  return resolveHoldingPricesPure(holdings.map(toPricableHolding), lastFillBySymbol, asOf, usdToIlsRate);
}

/** `findLastFillPricesInTransaction` + `priceHoldingRows` for callers that don't already hold a transaction. */
export async function resolveHoldingPrices(
  userId: string,
  holdings: readonly PricableHoldingRow[],
  asOf: Date,
  usdToIlsRate: number,
): Promise<Map<string, ResolvedHoldingPrice>> {
  const lastFills = await withUserScope(userId, (tx) =>
    findLastFillPricesInTransaction(
      tx,
      userId,
      holdings.map((h) => h.symbol),
    ),
  );
  return priceHoldingRows(holdings, lastFills, asOf, usdToIlsRate);
}

/**
 * Every open (`quantity > 0`) HIFO lot across all of this user's
 * holdings, oldest acquisition first — feeds the portfolio chart's
 * "open cost basis by acquisition date" area series (Phase 2, ad hoc).
 * Deliberately excludes fully-consumed lots (kept at `quantity: 0`,
 * never deleted — see `HoldingLot`'s own schema doc comment): a
 * liquidated lot's `costBasis` was already zeroed out by
 * `applyHoldingLotTracking`, so including it would only ever contribute
 * zero to the running sum, not a real historical data point.
 */
export async function listOpenHoldingLots(userId: string) {
  return withUserScope(userId, (tx) =>
    tx.holdingLot.findMany({
      where: { userId, quantity: { gt: 0 } },
      orderBy: { acquiredAt: "asc" },
      select: { acquiredAt: true, costBasis: true },
    }),
  );
}

export type AgentTradeWinRate = {
  settledSellCount: number;
  winningSellCount: number;
};

/**
 * "Win rate" here means: of this account's SETTLED SELL trades with a
 * recorded realized P&L, what fraction closed with `realizedPnlAgorot >
 * 0`. Deliberately scoped to every settled sell on the account, not
 * exclusively ones the Tier-0 paper-trading agent itself placed — `Trade`
 * has no column distinguishing an agent-submitted fill from one entered
 * through `/trading`'s own interactive order form (both paths write the
 * same table, see `paper-trades.ts`'s own doc comment), so a genuinely
 * agent-only figure isn't derivable without a schema change. A PENDING
 * trade (accepted but not yet filled) and a BUY (nothing realized yet)
 * are both excluded, since neither has a `realizedPnlAgorot` to judge.
 */
export async function getAgentTradeWinRate(userId: string): Promise<AgentTradeWinRate> {
  return withUserScope(userId, async (tx) => {
    const settledSells = await tx.trade.findMany({
      where: { userId, status: "SETTLED", side: "SELL", realizedPnlAgorot: { not: null } },
      select: { realizedPnlAgorot: true },
    });
    const settledSellCount = settledSells.length;
    const winningSellCount = settledSells.filter((trade) => (trade.realizedPnlAgorot ?? 0n) > 0n).length;
    return { settledSellCount, winningSellCount };
  });
}

/** A trade already recorded under this idempotency key, if any — the route checks this before executing, so a retried submission never re-executes. */
export async function findTradeByIdempotencyKey(userId: string, idempotencyKey: string) {
  return withUserScope(userId, (tx) => tx.trade.findFirst({ where: { userId, idempotencyKey } }));
}

export type ExecuteTradeInput = {
  symbol: string;
  side: "BUY" | "SELL";
  /** Must already be validated positive by the caller — the DAL trusts its input types, per project convention (validation happens at the Zod boundary, not re-checked here). */
  quantity: number;
  priceAgorot: Agorot;
  /** The instrument's native execution price (USD cents for every mock symbol today). */
  nativePriceAmount: NativeAmount;
  currency: CurrencyCode;
  /** ILS per 1 unit of `currency` at execution — frozen onto the Trade row as a historical fact. */
  exchangeRate: number;
  executedAt: Date;
  idempotencyKey?: string;
};

export type ExecuteTradeResult =
  | { ok: true; trade: NonNullable<Awaited<ReturnType<typeof listTrades>>>[number]; holding: NonNullable<Awaited<ReturnType<typeof listPortfolioHoldings>>>[number] }
  | { ok: false; error: "insufficient_shares" };

type AppliedTrade = {
  holding: NonNullable<Awaited<ReturnType<typeof listPortfolioHoldings>>>[number];
  totalAgorot: Agorot;
  nativeTotalAmount: NativeAmount;
  realizedPnlAgorot: Agorot | null;
  nativeRealizedPnl: NativeAmount | null;
};

type ApplyTradeResult = { ok: true } & AppliedTrade | { ok: false; error: "insufficient_shares" };

/**
 * Finds-or-creates the holding for `input.symbol` and applies this
 * trade's weighted-average cost-basis delta to it — the part of
 * `executeTradeInTransaction` that's genuinely shared with the two-phase
 * paper-trading settlement path (`settlePaperTradeReceipt`, which needs
 * to apply cost basis to an ALREADY-EXISTING pending Trade's holding
 * using the real settled price, not create a brand-new Trade row the way
 * this function's own caller below does). Never touches the `Trade`
 * table itself — that split is exactly what lets both callers reuse this
 * one piece of math.
 */
async function applyTradeToHolding(
  tx: ScopedTransactionClient,
  userId: string,
  input: Pick<ExecuteTradeInput, "symbol" | "side" | "quantity" | "priceAgorot" | "nativePriceAmount" | "currency">,
): Promise<ApplyTradeResult> {
  const existingHolding = await tx.portfolioHolding.findFirst({ where: { userId, symbol: input.symbol } });
  const totalAgorot = multiplyAgorot(input.priceAgorot, input.quantity);
  const nativeTotalAmount = multiplyNativeAmount(input.nativePriceAmount, input.quantity);

  const currentPosition: HoldingPosition = existingHolding
    ? {
        quantity: existingHolding.quantity.toNumber(),
        currency: input.currency,
        totalCostBasis: agorot(Number(existingHolding.totalCostBasis)),
        nativeCostBasis: nativeAmount(Number(existingHolding.nativeCostBasis)),
      }
    : { quantity: 0, currency: input.currency, totalCostBasis: agorot(0), nativeCostBasis: nativeAmount(0) };

  let nextPosition: HoldingPosition;
  let realizedPnlAgorot: Agorot | null = null;
  let nativeRealizedPnl: NativeAmount | null = null;

  if (input.side === "BUY") {
    nextPosition = applyBuy(currentPosition, input.quantity, totalAgorot, nativeTotalAmount);
  } else {
    if (input.quantity > currentPosition.quantity) {
      return { ok: false, error: "insufficient_shares" };
    }
    const sellResult = applySell(currentPosition, input.quantity, input.priceAgorot, input.nativePriceAmount);
    nextPosition = sellResult.position;
    realizedPnlAgorot = sellResult.realizedPnl;
    nativeRealizedPnl = sellResult.nativeRealizedPnl;
  }

  const holding = existingHolding
    ? await tx.portfolioHolding.update({
        where: { id: existingHolding.id },
        data: {
          quantity: nextPosition.quantity.toString(),
          totalCostBasis: BigInt(nextPosition.totalCostBasis),
          nativeCostBasis: BigInt(nextPosition.nativeCostBasis),
        },
      })
    : await tx.portfolioHolding.create({
        data: {
          userId,
          symbol: input.symbol,
          currency: input.currency,
          quantity: nextPosition.quantity.toString(),
          totalCostBasis: BigInt(nextPosition.totalCostBasis),
          nativeCostBasis: BigInt(nextPosition.nativeCostBasis),
        },
      });

  return { ok: true, holding, totalAgorot, nativeTotalAmount, realizedPnlAgorot, nativeRealizedPnl };
}

/**
 * Executes a simulated order: updates the holding's weighted-average
 * cost basis (src/lib/portfolio-math.ts) and appends an immutable Trade
 * row to the blotter. A fully-liquidated holding is kept at quantity 0
 * rather than deleted — deleting it would cascade-delete every historical
 * Trade against it (schema.prisma's `onDelete: Cascade` on
 * Trade.portfolioHolding), destroying the blotter for that symbol.
 *
 * Always books `status: "SETTLED"` immediately — every caller of this
 * function (the authenticated `/api/trades` route, the seed script) is a
 * SYNCHRONOUS execution with a known-final price at creation time, unlike
 * the async paper-trading-agent webhook path, which has a genuine
 * PENDING-then-SETTLED lifecycle and therefore does NOT call this
 * function for its initial (pending) receipt — see
 * `recordPendingPaperTrade`/`settlePaperTradeReceipt` in paper-trades.ts.
 */
export async function executeTradeInTransaction(
  tx: ScopedTransactionClient,
  userId: string,
  input: ExecuteTradeInput,
): Promise<ExecuteTradeResult> {
  const applied = await applyTradeToHolding(tx, userId, input);
  if (!applied.ok) return applied;

  const trade = await tx.trade.create({
    data: {
      userId,
      portfolioHoldingId: applied.holding.id,
      symbol: input.symbol,
      side: input.side,
      currency: input.currency,
      quantity: input.quantity.toString(),
      priceAgorot: BigInt(input.priceAgorot),
      totalAgorot: BigInt(applied.totalAgorot),
      realizedPnlAgorot: applied.realizedPnlAgorot !== null ? BigInt(applied.realizedPnlAgorot) : undefined,
      nativePriceAmount: BigInt(input.nativePriceAmount),
      nativeTotalAmount: BigInt(applied.nativeTotalAmount),
      nativeRealizedPnl: applied.nativeRealizedPnl !== null ? BigInt(applied.nativeRealizedPnl) : undefined,
      exchangeRateAtEntry: input.exchangeRate.toString(),
      executedAt: input.executedAt,
      idempotencyKey: input.idempotencyKey,
      status: "SETTLED",
    },
  });

  return { ok: true, trade, holding: applied.holding };
}

export type PendingTradeInput = Pick<
  ExecuteTradeInput,
  "symbol" | "side" | "quantity" | "priceAgorot" | "nativePriceAmount" | "currency" | "exchangeRate" | "executedAt" | "idempotencyKey"
>;

/**
 * Creates a PENDING Trade row with NO cost-basis impact at all — the
 * holding is found-or-created (a brand-new symbol needs a row to attach
 * the Trade to, per `Trade.portfolioHoldingId`'s NOT NULL constraint) but
 * its quantity/cost-basis are left completely untouched until settlement.
 *
 * This is a deliberate design choice the task itself didn't spell out:
 * the whole point of a pending/settled split is that the ORIGINAL limit
 * price is provisional (may differ from the real fill), and this app's
 * weighted-average cost-basis math has no clean way to "correct" itself
 * after the fact (AGENTS.md's own tax-lot module docstring: a cost basis
 * "isn't reconstructable later without replaying the full trade
 * history"). Applying it twice — once provisionally, once for real at
 * settlement — would either double-count or require an ad hoc reversal.
 * Deferring the ENTIRE cost-basis effect to settlement, where the real
 * price is finally known, avoids that class of bug entirely.
 */
export async function createPendingTrade(
  tx: ScopedTransactionClient,
  userId: string,
  input: PendingTradeInput,
) {
  let holding = await tx.portfolioHolding.findFirst({ where: { userId, symbol: input.symbol } });
  if (!holding) {
    holding = await tx.portfolioHolding.create({
      data: { userId, symbol: input.symbol, currency: input.currency, quantity: "0", totalCostBasis: 0n, nativeCostBasis: 0n },
    });
  }

  const totalAgorot = multiplyAgorot(input.priceAgorot, input.quantity);
  const nativeTotalAmount = multiplyNativeAmount(input.nativePriceAmount, input.quantity);

  return tx.trade.create({
    data: {
      userId,
      portfolioHoldingId: holding.id,
      symbol: input.symbol,
      side: input.side,
      currency: input.currency,
      quantity: input.quantity.toString(),
      priceAgorot: BigInt(input.priceAgorot),
      totalAgorot: BigInt(totalAgorot),
      nativePriceAmount: BigInt(input.nativePriceAmount),
      nativeTotalAmount: BigInt(nativeTotalAmount),
      exchangeRateAtEntry: input.exchangeRate.toString(),
      executedAt: input.executedAt,
      idempotencyKey: input.idempotencyKey,
      status: "PENDING",
    },
  });
}

export type SettleTradeInput = Pick<ExecuteTradeInput, "symbol" | "side" | "quantity" | "currency" | "exchangeRate"> & {
  /** The REAL fill price/total — not the original pending order's limit price. */
  priceAgorot: Agorot;
  nativePriceAmount: NativeAmount;
  settledAt: Date;
};

/**
 * Applies the real, settled cost-basis effect to an existing PENDING
 * `Trade` row and flips it to SETTLED — used by `settlePaperTradeReceipt`
 * once a `Trade` created via `createPendingTrade` above is known.
 */
export async function settleExistingTrade(
  tx: ScopedTransactionClient,
  userId: string,
  tradeId: string,
  input: SettleTradeInput,
): Promise<ExecuteTradeResult> {
  const applied = await applyTradeToHolding(tx, userId, input);
  if (!applied.ok) return applied;

  const trade = await tx.trade.update({
    where: { id: tradeId },
    data: {
      priceAgorot: BigInt(input.priceAgorot),
      totalAgorot: BigInt(applied.totalAgorot),
      realizedPnlAgorot: applied.realizedPnlAgorot !== null ? BigInt(applied.realizedPnlAgorot) : undefined,
      nativePriceAmount: BigInt(input.nativePriceAmount),
      nativeTotalAmount: BigInt(applied.nativeTotalAmount),
      nativeRealizedPnl: applied.nativeRealizedPnl !== null ? BigInt(applied.nativeRealizedPnl) : undefined,
      executedAt: input.settledAt,
      status: "SETTLED",
    },
  });

  return { ok: true, trade, holding: applied.holding };
}

/**
 * The `withUserScope`-wrapping form, for callers that have no
 * transaction of their own open (the authenticated `/api/trades`
 * route). A caller that DOES already hold one — the signed-receipt
 * webhook, which must write the Trade, the ledger row, and the
 * ledger-commit link atomically or not at all — calls
 * `executeTradeInTransaction` directly instead, rather than nesting a
 * second scoped transaction inside the first. Same split, for the same
 * reason, as `fetchActiveRulesForEvaluation` vs.
 * `listActiveTransactionRulesForEvaluation` (AGENTS.md §3rr).
 */
export async function executeTrade(userId: string, input: ExecuteTradeInput): Promise<ExecuteTradeResult> {
  return withUserScope(userId, (tx) => executeTradeInTransaction(tx, userId, input));
}
