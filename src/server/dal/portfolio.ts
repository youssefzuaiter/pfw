import "server-only";
import { multiplyAgorot, agorot, type Agorot } from "../../lib/money";
import { applyBuy, applySell, type HoldingPosition } from "../../lib/portfolio-math";
import { withUserScope } from "../db/with-user-scope";

export async function listPortfolioHoldings(userId: string) {
  return withUserScope(userId, (tx) => tx.portfolioHolding.findMany({ where: { userId }, orderBy: { symbol: "asc" } }));
}

export async function getPortfolioHoldingBySymbol(userId: string, symbol: string) {
  return withUserScope(userId, (tx) => tx.portfolioHolding.findFirst({ where: { userId, symbol } }));
}

export async function listTrades(userId: string) {
  return withUserScope(userId, (tx) => tx.trade.findMany({ where: { userId }, orderBy: { executedAt: "desc" } }));
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
  executedAt: Date;
  idempotencyKey?: string;
};

export type ExecuteTradeResult =
  | { ok: true; trade: NonNullable<Awaited<ReturnType<typeof listTrades>>>[number]; holding: NonNullable<Awaited<ReturnType<typeof listPortfolioHoldings>>>[number] }
  | { ok: false; error: "insufficient_shares" };

/**
 * Executes a simulated order: updates the holding's weighted-average
 * cost basis (src/lib/portfolio-math.ts) and appends an immutable Trade
 * row to the blotter. A fully-liquidated holding is kept at quantity 0
 * rather than deleted — deleting it would cascade-delete every historical
 * Trade against it (schema.prisma's `onDelete: Cascade` on
 * Trade.portfolioHolding), destroying the blotter for that symbol.
 */
export async function executeTrade(userId: string, input: ExecuteTradeInput): Promise<ExecuteTradeResult> {
  return withUserScope(userId, async (tx) => {
    const existingHolding = await tx.portfolioHolding.findFirst({ where: { userId, symbol: input.symbol } });
    const totalAgorot = multiplyAgorot(input.priceAgorot, input.quantity);

    const currentPosition: HoldingPosition = existingHolding
      ? { quantity: existingHolding.quantity.toNumber(), totalCostBasis: agorot(Number(existingHolding.totalCostBasis)) }
      : { quantity: 0, totalCostBasis: agorot(0) };

    let nextPosition: HoldingPosition;
    let realizedPnl: Agorot | null = null;

    if (input.side === "BUY") {
      nextPosition = applyBuy(currentPosition, input.quantity, totalAgorot);
    } else {
      if (input.quantity > currentPosition.quantity) {
        return { ok: false, error: "insufficient_shares" };
      }
      const sellResult = applySell(currentPosition, input.quantity, input.priceAgorot);
      nextPosition = sellResult.position;
      realizedPnl = sellResult.realizedPnl;
    }

    const holding = existingHolding
      ? await tx.portfolioHolding.update({
          where: { id: existingHolding.id },
          data: { quantity: nextPosition.quantity.toString(), totalCostBasis: BigInt(nextPosition.totalCostBasis) },
        })
      : await tx.portfolioHolding.create({
          data: {
            userId,
            symbol: input.symbol,
            quantity: nextPosition.quantity.toString(),
            totalCostBasis: BigInt(nextPosition.totalCostBasis),
          },
        });

    const trade = await tx.trade.create({
      data: {
        userId,
        portfolioHoldingId: holding.id,
        symbol: input.symbol,
        side: input.side,
        quantity: input.quantity.toString(),
        priceAgorot: BigInt(input.priceAgorot),
        totalAgorot: BigInt(totalAgorot),
        realizedPnlAgorot: realizedPnl !== null ? BigInt(realizedPnl) : undefined,
        executedAt: input.executedAt,
        idempotencyKey: input.idempotencyKey,
      },
    });

    return { ok: true, trade, holding };
  });
}
