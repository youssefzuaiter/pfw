/**
 * EU Open Banking PSD2 Ingestion (ad hoc) — a MOCK client, not a real
 * integration.
 *
 * WHAT THIS IS: a well-typed abstraction shaped like a real PSD2 API —
 * loosely modeled on the Berlin Group NextGenPSD2 Framework's actual
 * conventions (a consent/access-token flow, `GET /accounts`, `GET
 * /accounts/{id}/transactions`, amounts as decimal STRINGS in major
 * units — a real, easy-to-get-wrong quirk deliberately reproduced here
 * rather than glossed over — and its real error-code vocabulary:
 * `CONSENT_INVALID`, `CONSENT_EXPIRED`, `ACCESS_EXCEEDED`,
 * `SERVICE_UNAVAILABLE`, `PSU_CREDENTIALS_INVALID`).
 *
 * WHAT THIS IS NOT: a real integration with any bank, aggregator (Tink,
 * TrueLayer, Nordigen/GoCardless Bank Account Data, Salt Edge), or
 * regulator. Real PSD2 connectivity requires becoming (or partnering
 * with) a licensed AISP/TPP, eIDAS-qualified certificates (QWAC/QSEAL)
 * for mutual-TLS bank authentication, and per-bank API quirks real
 * aggregators exist specifically to paper over — none of that is being
 * built or claimed here. `MOCK_INSTITUTIONS` are fictional; connecting
 * to one never contacts any real network endpoint.
 *
 * Deterministic per institution (`createSeededRandom`, `src/lib/monte-carlo.ts`
 * — the same mulberry32 algorithm `prisma/seed/rng.ts` uses, reused here
 * rather than re-implemented a third time), with dates anchored to real
 * "now" at generation time — same "same inputs -> same demo data, but it
 * always looks recent" precedent the seed script itself establishes.
 * Simulated latency and a real (if fake) failure rate so callers have to
 * handle the same failure shapes a genuine flaky external API would
 * produce, per this feature's own explicit ask.
 */

import { randomBytes } from "node:crypto";
import { createSeededRandom } from "../monte-carlo";
import type { CurrencyCode } from "../currency";

export type Psd2Institution = {
  id: string;
  name: string;
  country: "DE" | "FR" | "NL" | "GB" | "IE";
  currency: Extract<CurrencyCode, "EUR" | "GBP">;
};

/** Fictional institutions — never a real bank identifier. */
export const MOCK_INSTITUTIONS: readonly Psd2Institution[] = [
  { id: "mock-deutschebank-de", name: "Deutsche Bank (Mock)", country: "DE", currency: "EUR" },
  { id: "mock-bnpparibas-fr", name: "BNP Paribas (Mock)", country: "FR", currency: "EUR" },
  { id: "mock-ing-nl", name: "ING (Mock)", country: "NL", currency: "EUR" },
  { id: "mock-barclays-gb", name: "Barclays (Mock)", country: "GB", currency: "GBP" },
  { id: "mock-aib-ie", name: "Allied Irish Banks (Mock)", country: "IE", currency: "EUR" },
];

export function findMockInstitution(institutionId: string): Psd2Institution | undefined {
  return MOCK_INSTITUTIONS.find((institution) => institution.id === institutionId);
}

/** Berlin Group represents an amount as a decimal STRING in MAJOR units (e.g. `"-12.50"`, not `-1250` minor units) — parsed via `parseDecimalToNativeAmount` (src/lib/currency.ts), never a naive `parseFloat`. */
export type Psd2Amount = { amount: string; currency: string };

export type Psd2Transaction = {
  transactionId: string;
  /** ISO `YYYY-MM-DD`. */
  bookingDate: string;
  transactionAmount: Psd2Amount;
  creditorName?: string;
  debtorName?: string;
  remittanceInformationUnstructured?: string;
};

export type Psd2AccountDetails = {
  resourceId: string;
  iban: string;
  currency: string;
  ownerName: string;
};

export type Psd2ErrorCode = "CONSENT_INVALID" | "CONSENT_EXPIRED" | "ACCESS_EXCEEDED" | "SERVICE_UNAVAILABLE" | "PSU_CREDENTIALS_INVALID";

export class Psd2ApiError extends Error {
  constructor(
    readonly code: Psd2ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "Psd2ApiError";
  }
}

export class UnknownInstitutionError extends Error {
  constructor(institutionId: string) {
    super(`Unknown mock institution: ${institutionId}`);
    this.name = "UnknownInstitutionError";
  }
}

const MIN_LATENCY_MS = 150;
const MAX_LATENCY_MS = 900;
/** ~1 in 12 calls — high enough that a real UI exercising this feature actually SEES the failure path, not just in theory. */
const FAILURE_RATE = 0.08;
const TRANSIENT_ERROR_CODES: readonly Psd2ErrorCode[] = ["SERVICE_UNAVAILABLE", "ACCESS_EXCEEDED", "CONSENT_EXPIRED"];

async function simulateNetworkLatency(randomFn: () => number): Promise<void> {
  const latencyMs = MIN_LATENCY_MS + randomFn() * (MAX_LATENCY_MS - MIN_LATENCY_MS);
  await new Promise((resolve) => setTimeout(resolve, latencyMs));
}

function maybeThrowTransientFailure(randomFn: () => number): void {
  if (randomFn() >= FAILURE_RATE) return;
  const code = TRANSIENT_ERROR_CODES[Math.floor(randomFn() * TRANSIENT_ERROR_CODES.length)];
  throw new Psd2ApiError(code, `Simulated PSD2 API failure: ${code}`);
}

/** A real PSD2 consent under the RTS on SCA is valid for a maximum of 90 days before re-authentication is required — mirrored here even in the mock, since a `BankConnection.expiresAt` this far in the future is a real, checkable behavior this feature's UI/sync logic depends on. */
const MOCK_CONSENT_VALIDITY_MS = 90 * 24 * 60 * 60 * 1000;

function hashInstitutionIdToSeed(institutionId: string): number {
  let hash = 0;
  for (let i = 0; i < institutionId.length; i++) {
    hash = (Math.imul(31, hash) + institutionId.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

function generateMockIban(institution: Psd2Institution, randomFn: () => number): string {
  const digits = Array.from({ length: 20 }, () => Math.floor(randomFn() * 10)).join("");
  return `${institution.country}00MOCK${digits}`.slice(0, 22);
}

export type Psd2ConnectResult = {
  accessToken: string;
  expiresAt: Date;
  account: Psd2AccountDetails;
};

/**
 * Simulates completing a PSD2 consent/OAuth flow for `institutionId`.
 * `randomFn` is injectable for deterministic tests; production code
 * leaves it as `Math.random` so latency/failure simulation is genuinely
 * random per attempt (unlike `fetchTransactions`, where the underlying
 * DATA must stay deterministic per institution — see that function's own
 * doc comment).
 */
export async function connectToInstitution(institutionId: string, randomFn: () => number = Math.random): Promise<Psd2ConnectResult> {
  const institution = findMockInstitution(institutionId);
  if (!institution) throw new UnknownInstitutionError(institutionId);

  await simulateNetworkLatency(randomFn);
  maybeThrowTransientFailure(randomFn);

  const accessToken = `mock_psd2_${randomBytes(24).toString("hex")}`;
  const expiresAt = new Date(Date.now() + MOCK_CONSENT_VALIDITY_MS);
  const account: Psd2AccountDetails = {
    resourceId: `mock-resource-${randomBytes(8).toString("hex")}`,
    iban: generateMockIban(institution, randomFn),
    currency: institution.currency,
    ownerName: "Mock Account Holder",
  };

  return { accessToken, expiresAt, account };
}

const HISTORY_DAYS = 60;
const GENERIC_MERCHANTS = ["Carrefour", "Rewe", "SNCF", "Deutsche Bahn", "Zalando", "Amazon EU", "Netflix", "Spotify", "Shell", "IKEA"];

/**
 * Deterministic per institution — the full trailing `HISTORY_DAYS`-day
 * transaction history is generated once per institution id (a pure
 * function of the id, not of when it's called, except that the DATES
 * themselves are anchored to real "now" at generation time — the exact
 * "same inputs -> same demo data, always looks recent" shape
 * `prisma/seed/index.ts` already establishes for the whole app's mock
 * data). This is what makes repeated syncs genuinely idempotent: syncing
 * twice in the same day returns the identical transaction set both
 * times, so `src/server/banking/sync-service.ts`'s dedupe logic has
 * something real to prove itself against, not just a hand-wave.
 */
function generateFullMockHistory(institution: Psd2Institution): Psd2Transaction[] {
  const random = createSeededRandom(hashInstitutionIdToSeed(institution.id));
  const now = new Date();
  const transactions: Psd2Transaction[] = [];

  for (let dayOffset = HISTORY_DAYS; dayOffset >= 0; dayOffset--) {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() - dayOffset);
    const dateKey = date.toISOString().slice(0, 10);

    const transactionsToday = Math.floor(random() * 3); // 0, 1, or 2
    for (let i = 0; i < transactionsToday; i++) {
      const merchant = GENERIC_MERCHANTS[Math.floor(random() * GENERIC_MERCHANTS.length)];
      const majorUnits = 5 + random() * 145; // roughly 5.00–150.00 in the institution's currency
      const amount = (-Math.round(majorUnits * 100) / 100).toFixed(2); // always an expense in this mock — real PSD2 data includes income too, but this feature's own scope is spending ingestion, matching this app's existing CSV-import precedent

      transactions.push({
        transactionId: `mock-${institution.id}-${dateKey}-${i}`,
        bookingDate: dateKey,
        transactionAmount: { amount, currency: institution.currency },
        creditorName: merchant,
        remittanceInformationUnstructured: merchant,
      });
    }
  }

  return transactions;
}

/**
 * Fetches every mock transaction booked on or after `since` for
 * `institutionId` — the incremental-sync shape a real PSD2 `GET
 * /accounts/{id}/transactions?dateFrom=...` call would have.
 */
export async function fetchTransactions(
  institutionId: string,
  since: Date,
  randomFn: () => number = Math.random,
): Promise<Psd2Transaction[]> {
  const institution = findMockInstitution(institutionId);
  if (!institution) throw new UnknownInstitutionError(institutionId);

  await simulateNetworkLatency(randomFn);
  maybeThrowTransientFailure(randomFn);

  const sinceKey = since.toISOString().slice(0, 10);
  return generateFullMockHistory(institution).filter((transaction) => transaction.bookingDate >= sinceKey);
}
