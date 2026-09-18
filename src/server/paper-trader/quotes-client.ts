import "server-only";
import { z } from "zod";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, computeWebhookSignature } from "../../lib/webhook-signature";
import { getPaperTraderServiceUrl, getWebhookSecret } from "../env";

/**
 * Server-side, HMAC-signed call to the Tier-0 agent's `POST /control/quotes`
 * — Alpaca's latest IEX trade price for a batch of symbols (AGENTS.md
 * §3xx). The agent is the quote source on purpose: it is the one
 * component that already holds Alpaca credentials, and §3uu made it this
 * app's single trader target. Signed exactly the way `/api/agent/halt`
 * signs its request (the same shared `WEBHOOK_SECRET`, in the reverse
 * direction of the receipt webhooks), server-only — never the browser.
 *
 * The response is untrusted input crossing a trust boundary like any
 * other (`rate-sync.ts`, `price-sync.ts`): Zod-validated, every price
 * re-checked positive and finite, every timestamp parsed, anything
 * malformed dropped rather than written.
 */
const QUOTES_TIMEOUT_MS = 10_000;

const QuotesResponseSchema = z.object({
  quotes: z.record(z.string(), z.object({ price: z.string(), timestamp: z.string() })),
  missing: z.array(z.string()).default([]),
});

export type PaperTraderQuote = { symbol: string; priceUsd: number; observedAt: Date };

export type PaperTraderQuotesResult = {
  quotes: PaperTraderQuote[];
  /** Symbols the agent asked Alpaca about and got nothing back for. */
  missing: string[];
};

export async function fetchPaperTraderQuotes(
  symbols: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<PaperTraderQuotesResult> {
  const wanted = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
  if (wanted.length === 0) return { quotes: [], missing: [] };

  const body = JSON.stringify({ symbols: wanted });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = computeWebhookSignature(body, timestamp, getWebhookSecret());

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), QUOTES_TIMEOUT_MS);
  let payload: unknown;
  try {
    const response = await fetchImpl(`${getPaperTraderServiceUrl()}/control/quotes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [SIGNATURE_HEADER]: `sha256=${signature}`,
        [TIMESTAMP_HEADER]: timestamp,
      },
      body,
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`paper trader answered HTTP ${response.status} for /control/quotes`);
    }
    payload = await response.json();
  } finally {
    clearTimeout(timeout);
  }

  const parsed = QuotesResponseSchema.parse(payload);
  const quotes: PaperTraderQuote[] = [];
  for (const [rawSymbol, quote] of Object.entries(parsed.quotes)) {
    const symbol = rawSymbol.toUpperCase();
    const priceUsd = Number(quote.price);
    const observedAt = new Date(quote.timestamp);
    // A malformed entry is dropped, which lands its symbol in `missing`
    // below — the caller keeps whatever it already had for it.
    if (!Number.isFinite(priceUsd) || priceUsd <= 0 || Number.isNaN(observedAt.getTime())) continue;
    if (!wanted.includes(symbol)) continue; // never store a symbol nobody asked for
    quotes.push({ symbol, priceUsd, observedAt });
  }
  const answered = new Set(quotes.map((q) => q.symbol));
  return { quotes, missing: wanted.filter((s) => !answered.has(s)) };
}
