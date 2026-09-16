import "server-only";
import { settlePaperTradeReceipt, type PaperTradeReceiptInput } from "../dal/paper-trades";

/**
 * The settlement race, observed live (trader integration hardening, ad
 * hoc): Alpaca fills a paper order within milliseconds, and the trader's
 * settlement stream is an independent task — so the "settled" receipt
 * can reach this route BEFORE the "pending" receipt's transaction has
 * committed (seen at 16ms apart; at 77ms apart it settled fine).
 * `settlePaperTradeReceipt` then finds no pending row, tries to CREATE a
 * settled trade, and collides with the pending insert on
 * `@@unique([userId, idempotencyKey])`. Answering "duplicate" there (the
 * old behaviour) silently dropped the settlement: the pending row won,
 * the trader logged "delivered", and the trade stayed PENDING with no
 * ledger entry, forever.
 *
 * A unique-constraint collision on a settlement therefore means exactly
 * one thing — the pending row exists NOW — so the settle is retried
 * once, on the row that just won. If that still fails, the caller gets a
 * retryable 503 instead of a reassuring 200, and the trader's outbox
 * brings the receipt back.
 */
export type SettleFn = typeof settlePaperTradeReceipt;

export async function settleWithRaceRetry(
  userId: string,
  receiptInput: PaperTradeReceiptInput,
  /** Injectable so the retry logic is unit-testable against a scripted P2002 — the real DAL by default. */
  settle: SettleFn = settlePaperTradeReceipt,
): Promise<Awaited<ReturnType<typeof settlePaperTradeReceipt>> | { status: "race_unresolved" }> {
  try {
    return await settle(userId, receiptInput);
  } catch (error) {
    if (!isUniqueConstraintViolation(error)) throw error;
    console.warn(
      `POST /api/webhooks/trades: settlement ${receiptInput.idempotencyKey} raced its own pending receipt; retrying once`,
    );
    try {
      return await settle(userId, receiptInput);
    } catch (retryError) {
      console.error("POST /api/webhooks/trades: settlement retry after race failed", retryError);
      return { status: "race_unresolved" };
    }
  }
}


function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === "P2002";
}
