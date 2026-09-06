import "server-only";
import { applyRules, type TransactionRuleData } from "../../lib/categorization/rule-engine";
import { neutralizeFormulaInjection } from "../../lib/csv-import/formula-injection";
import type { CurrencyCode, NativeAmount } from "../../lib/currency";
import { consumeLotsHifo, type OpenHoldingLot } from "../../lib/holding-lots";
import { agorot, formatAgorot, isNegativeAgorot, type Agorot } from "../../lib/money";
import { withUserScope, type ScopedTransactionClient } from "../db/with-user-scope";
import { appendLedgerCommit, buildLedgerState } from "./ledger-commits";
import { createPendingTrade, executeTradeInTransaction, settleExistingTrade } from "./portfolio";
import { fetchActiveRulesForEvaluation } from "./transaction-rules";

/**
 * Books signed paper-trade receipts from the Tier-0 trading agent (the
 * local FastAPI service) into this app's blotter, ledger, and envelopes.
 *
 * Two-phase lifecycle (ad hoc, extends the original single-shot design —
 * see TradeStatus's own schema doc comment for the full rationale): a
 * "pending" receipt fires the instant Alpaca ACCEPTS an order — before
 * anything has actually happened at the real market — and only creates
 * the `Trade` row, deliberately WITHOUT touching the envelope/ledger at
 * all. A "settled" receipt fires once Alpaca reports a real fill, and is
 * the only point at which `NotableTransaction`/`LedgerCommit` are ever
 * created — money should never appear "spent" in a user's envelope for
 * an order that might sit unfilled indefinitely (verified live: every
 * paper order this agent submitted before this fix was priced against a
 * synthetic quote wildly divorced from the real market and never filled
 * at all, while the ledger had already booked each one as complete).
 *
 * Atomicity is not ceremony in either phase. A settled receipt that
 * produced a ledger row but no `LedgerCommit` link would leave a gap in
 * that transaction's hash chain (§3mm); either half-write is worse than
 * the whole thing failing and the agent retrying, which its own delivery
 * retry already does — both `recordPendingPaperTrade` and
 * `settlePaperTradeReceipt` run inside ONE `withUserScope` transaction.
 *
 * Where this deliberately DIFFERS from `/api/trades` (the interactive
 * route): that one refuses to let the caller supply a price, looking it
 * up server-side instead, because a client that names its own fill price
 * dictates its own P&L. Here the fill already happened, at Alpaca, at a
 * price this app has no independent record of — the receipt IS the
 * execution record, and the HMAC signature (verified before this module
 * is ever called) is what makes it trustworthy.
 */

/** Stable slug, per the same permanent-slugs law Tier 2's `DEFAULT_CATEGORY_RULES` follow — a user renaming the category must not break this. */
export const PAPER_TRADING_CATEGORY_SLUG = "paper-trading";

/** Bilingual, matching every seeded category's own `Name [שם]` shape (`prisma/seed/israeli-data.ts`). */
const PAPER_TRADING_CATEGORY_NAME = "Paper Trading [מסחר הדגמה]";

export type PaperTradeReceiptInput = {
  /** Mirrors `Trade.idempotencyKey`. Also the ledger row's `providerTransactionId`, so BOTH tables dedupe at the DB level. */
  idempotencyKey: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  priceAgorot: Agorot;
  nativePriceAmount: NativeAmount;
  currency: CurrencyCode;
  /** ILS per 1 unit of `currency`, frozen onto the row as a historical fact (§1 law #3). */
  exchangeRate: number;
  executedAt: Date;
  /** The agent's news headline — untrusted free text, neutralized before storage. Unused (and not needed) for a pending receipt, since no NotableTransaction is written yet. */
  headline: string;
  /** Alpaca's own order id, for traceability back to the broker's blotter. */
  orderId: string;
};

export type RecordPendingTradeResult =
  | { status: "recorded"; tradeId: string }
  | { status: "duplicate"; tradeId: string };

export type RecordPaperTradeResult =
  | {
      status: "recorded";
      tradeId: string;
      transactionId: string;
      categoryId: string;
      /** Signed — negative for a BUY, which is what deducts the envelope. */
      amountAgorot: Agorot;
    }
  | { status: "duplicate"; tradeId: string }
  | { status: "rejected"; reason: "no_bank_account" | "insufficient_shares" };

export async function recordPendingPaperTrade(
  userId: string,
  input: PaperTradeReceiptInput,
): Promise<RecordPendingTradeResult> {
  return withUserScope(userId, async (tx) => {
    const existing = await tx.trade.findFirst({
      where: { userId, idempotencyKey: input.idempotencyKey },
      select: { id: true },
    });
    if (existing) return { status: "duplicate", tradeId: existing.id };

    const trade = await createPendingTrade(tx, userId, {
      symbol: input.symbol,
      side: input.side,
      quantity: input.quantity,
      priceAgorot: input.priceAgorot,
      nativePriceAmount: input.nativePriceAmount,
      currency: input.currency,
      exchangeRate: input.exchangeRate,
      executedAt: input.executedAt,
      idempotencyKey: input.idempotencyKey,
    });

    return { status: "recorded", tradeId: trade.id };
  });
}

/**
 * The ledger-booking half shared by both the "settle an existing pending
 * trade" path and the "no pending trade was ever found" fallback path
 * below — reads the final, already-settled `Trade` row's own totals
 * rather than re-deriving them, so the ledger row and the blotter row
 * can never disagree.
 */
/**
 * Persisted, per-lot HIFO tracking (ad hoc, Phase 2) — additive to, and
 * deliberately independent of, the existing weighted-average
 * `PortfolioHolding.quantity`/`totalCostBasis` bookkeeping
 * `settleExistingTrade`/`executeTradeInTransaction` already maintain
 * (unchanged by this function). See `HoldingLot`'s own schema doc
 * comment for the full reasoning; this is scoped to the paper-trading
 * webhook settlement path only, per this feature's own stated scope —
 * `/api/trades` (the interactive route) never calls this.
 *
 * BUY: records a new open lot at the settled price/quantity. Returns
 * `null` — nothing to log for PFW's ledger on the acquiring side.
 *
 * SELL: consumes open lots via HIFO (`consumeLotsHifo` — sorted by
 * PER-SHARE cost, not raw total cost basis; see that module's own doc
 * comment for why the literal "sort by costBasis descending" reading
 * would be a real bug) and returns a human-readable note describing the
 * realized gain/loss, for the caller to append to the resulting
 * `NotableTransaction.description`. Does NOT touch
 * `Trade.realizedPnlAgorot` — that field stays the existing
 * weighted-average figure `/trading/portfolio` and other screens already
 * depend on; writing a second, different "the" realized gain into the
 * same column would be genuinely confusing, not an improvement.
 */
async function applyHoldingLotTracking(
  tx: ScopedTransactionClient,
  userId: string,
  holdingId: string,
  input: Pick<PaperTradeReceiptInput, "side" | "quantity" | "executedAt">,
  settledTotalAgorot: Agorot,
  settledPriceAgorot: Agorot,
): Promise<string | null> {
  if (input.side === "BUY") {
    await tx.holdingLot.create({
      data: {
        userId,
        holdingId,
        quantity: input.quantity.toString(),
        costBasis: BigInt(settledTotalAgorot),
        acquiredAt: input.executedAt,
      },
    });
    return null;
  }

  const openLots = await tx.holdingLot.findMany({
    where: { userId, holdingId, quantity: { gt: 0 } },
  });
  const openHoldingLots: OpenHoldingLot[] = openLots.map((lot) => ({
    id: lot.id,
    quantity: lot.quantity.toNumber(),
    costBasisAgorot: agorot(Number(lot.costBasis)),
  }));

  const hifoResult = consumeLotsHifo(openHoldingLots, input.quantity, settledPriceAgorot);

  for (const consumption of hifoResult.consumptions) {
    if (consumption.remainingQuantity <= 1e-9) {
      // Kept at zero, never deleted — same "never delete financial
      // history" rule PortfolioHolding's own doc comment states for a
      // fully-liquidated holding.
      await tx.holdingLot.update({
        where: { id: consumption.lotId },
        data: { quantity: "0", costBasis: 0n },
      });
    } else {
      await tx.holdingLot.update({
        where: { id: consumption.lotId },
        data: {
          quantity: consumption.remainingQuantity.toString(),
          costBasis: BigInt(consumption.remainingCostBasisAgorot),
        },
      });
    }
  }

  const gainOrLoss = isNegativeAgorot(hifoResult.realizedGainAgorot) ? "loss" : "gain";
  return `HIFO realized ${gainOrLoss}: ${formatAgorot(hifoResult.realizedGainAgorot, { showPositiveSign: true })}`;
}

async function bookLedgerEntryForSettledTrade(
  tx: ScopedTransactionClient,
  userId: string,
  trade: { id: string; totalAgorot: bigint; nativeTotalAmount: bigint },
  input: Pick<PaperTradeReceiptInput, "idempotencyKey" | "symbol" | "side" | "quantity" | "nativePriceAmount" | "currency" | "exchangeRate" | "executedAt" | "headline">,
  lotNote: string | null,
) {
  // `NotableTransaction.bankAccountId` is required — every ledger row in
  // this app is anchored to a real account. There is no brokerage-cash
  // account model here, so the trade is booked against the user's own
  // account: one matching the trade's currency if they have it (a USD
  // fill against a USD account needs no fiction), otherwise their
  // oldest, deterministically. Modelling a genuine settlement account is
  // a schema change, not something to improvise here.
  const accounts = await tx.bankAccount.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { id: true, currency: true },
  });
  if (accounts.length === 0) return { status: "rejected" as const, reason: "no_bank_account" as const };
  const account = accounts.find((row) => row.currency === input.currency) ?? accounts[0];

  // The dedicated envelope's category. Created on demand rather than
  // seeded: categories are per-user rows, so seeding would only ever
  // reach users created after this shipped. `update: {}` deliberately
  // does NOT revive an archived category — a user who archived this
  // envelope archived it on purpose, and its balance simply stops
  // appearing on /budgets, exactly as it would for any other category.
  const paperTradingCategory = await tx.category.upsert({
    where: { userId_slug: { userId, slug: PAPER_TRADING_CATEGORY_SLUG } },
    update: {},
    create: { userId, slug: PAPER_TRADING_CATEGORY_SLUG, name: PAPER_TRADING_CATEGORY_NAME },
    select: { id: true },
  });

  // Signed, from the totals the (now-settled) trade itself already
  // holds — never re-multiplied here. A BUY is money leaving (negative),
  // which is precisely what `getEnvelopeBalances` counts as this
  // envelope's spend; a SELL is money returning.
  const magnitudeAgorot = Number(trade.totalAgorot);
  const magnitudeNative = Number(trade.nativeTotalAmount);
  const signedAgorot = agorot(input.side === "BUY" ? -magnitudeAgorot : magnitudeAgorot);
  const signedNative = input.side === "BUY" ? -magnitudeNative : magnitudeNative;

  // Both strings are untrusted: the headline came off the agent's news
  // feed, and the symbol is remote input too. Same neutralization every
  // other free-text ingest path in this app applies (§3j).
  const description = neutralizeFormulaInjection(
    `${input.side} ${input.quantity} ${input.symbol} @ ${input.nativePriceAmount / 100} ${input.currency} — ${input.headline}` +
      (lotNote ? ` (${lotNote})` : ""),
  );
  const merchantName = neutralizeFormulaInjection(`Paper Trading — ${input.symbol}`);

  // Tier 0: the user's own deterministic rules run first, exactly as
  // they do on manual entry and CSV import (§3rr). A `categorize`
  // action retargets this row away from the Paper Trading envelope; a
  // rule naming a slug the user has no category for falls through to
  // the default, the same fallthrough `createTransaction` already has.
  const activeRules = await fetchActiveRulesForEvaluation(tx, userId);
  const tier0Input: TransactionRuleData = { merchantName, description, amountAgorot: signedAgorot };
  const tier0 = applyRules(tier0Input, activeRules);

  let categoryId = paperTradingCategory.id;
  if (tier0.categorySlug) {
    const target = await tx.category.findFirst({
      where: { userId, slug: tier0.categorySlug, archivedAt: null },
      select: { id: true },
    });
    if (target) categoryId = target.id;
  }

  const created = await tx.notableTransaction.create({
    data: {
      userId,
      bankAccountId: account.id,
      categoryId,
      // Second DB-level dedupe, via `@@unique([userId, providerTransactionId])`
      // — the ledger row cannot be double-written even if the Trade
      // check above were somehow bypassed.
      providerTransactionId: `paper-trade:${input.idempotencyKey}`,
      occurredAt: input.executedAt,
      currency: input.currency,
      amount: BigInt(signedAgorot),
      nativeAmount: BigInt(signedNative),
      // Null for ILS, per the column's own contract.
      exchangeRateAtEntry: input.currency === "ILS" ? null : input.exchangeRate.toString(),
      description,
      merchantName: tier0.renamedMerchantName ?? merchantName,
      // `isManual` means manually *entered* (§3j) — this was not.
      isManual: false,
      // A signed receipt is unambiguous by construction, so nothing here
      // is low-confidence the way a categorization guess would be. Only
      // a user's own Tier 0 `flag` action puts it in the review queue.
      needsReview: tier0.forceNeedsReview ?? false,
    },
    include: { category: true },
  });

  // The CREATE link in this transaction's hash chain (§3mm), in the
  // same transaction as the row it documents.
  await appendLedgerCommit(tx, userId, {
    transactionId: created.id,
    action: "CREATE",
    state: buildLedgerState({ ...created, categoryName: created.category.name }),
  });

  return {
    status: "recorded" as const,
    tradeId: trade.id,
    transactionId: created.id,
    categoryId,
    amountAgorot: signedAgorot,
  };
}

export async function settlePaperTradeReceipt(
  userId: string,
  input: PaperTradeReceiptInput,
): Promise<RecordPaperTradeResult> {
  return withUserScope(userId, async (tx) => {
    // Durable replay check, inside the transaction. The route checks this
    // too, before doing any work, but only the DB's own
    // `@@unique([userId, idempotencyKey])` survives two receipts arriving
    // concurrently — same belt-and-braces split `/api/trades` already
    // uses for its in-memory cache vs. this constraint.
    const existingTrade = await tx.trade.findFirst({ where: { userId, idempotencyKey: input.idempotencyKey } });

    if (existingTrade?.status === "SETTLED") {
      return { status: "duplicate", tradeId: existingTrade.id };
    }

    // The normal path: a `createPendingTrade`-created row already exists
    // (from the "pending" receipt fired the instant Alpaca accepted the
    // order) — apply the REAL settled cost-basis effect to it now.
    //
    // The resilience path (`existingTrade` is undefined): the "pending"
    // receipt was never delivered or was lost — rather than reject a
    // real, HMAC-verified fill outright, fall back to the original
    // one-shot atomic behavior (create the Trade fully settled, in one
    // step) so a single missed delivery doesn't silently drop a real
    // trade from this app's books.
    const execution = existingTrade
      ? await settleExistingTrade(tx, userId, existingTrade.id, {
          symbol: input.symbol,
          side: input.side,
          quantity: input.quantity,
          priceAgorot: input.priceAgorot,
          nativePriceAmount: input.nativePriceAmount,
          currency: input.currency,
          exchangeRate: input.exchangeRate,
          settledAt: input.executedAt,
        })
      : await executeTradeInTransaction(tx, userId, {
          symbol: input.symbol,
          side: input.side,
          quantity: input.quantity,
          priceAgorot: input.priceAgorot,
          nativePriceAmount: input.nativePriceAmount,
          currency: input.currency,
          exchangeRate: input.exchangeRate,
          executedAt: input.executedAt,
          idempotencyKey: input.idempotencyKey,
        });

    if (!execution.ok) return { status: "rejected", reason: "insufficient_shares" };

    const lotNote = await applyHoldingLotTracking(
      tx,
      userId,
      execution.holding.id,
      input,
      agorot(Number(execution.trade.totalAgorot)),
      agorot(Number(execution.trade.priceAgorot)),
    );

    return bookLedgerEntryForSettledTrade(tx, userId, execution.trade, input, lotNote);
  });
}
