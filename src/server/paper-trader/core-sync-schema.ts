import { z } from "zod";

/**
 * The wire contract between the long-term core's router
 * (`~/paper-trader`'s `risk_router/core_sync.py`) and
 * `POST /api/webhooks/core` — schema version 1. Two kinds of request:
 *
 * - **`journal`**: a run of the router's append-only, hash-chained journal
 *   — each entry its position, the hash it claims, the hash it follows,
 *   and the line exactly as written. The journal is the router's own
 *   outbox: it sends from a cursor and advances it only when this app
 *   acknowledges, so nothing is lost and a replay is always safe.
 * - **`report`**: the router's latest self-report (is it trading, halted,
 *   waiting on the owner) and, hourly, its account — equity, cash and each
 *   position, in USD cents.
 *
 * Parsed AFTER the request's HMAC has been verified against the raw
 * bytes, like every other trader webhook, so none of this runs for an
 * unauthenticated caller. Every bound below exists because a signed body
 * is still untrusted input once parsed: a bug on the router's side must
 * not become an oversized write here.
 *
 * Deliberately NOT `.strict()`: a newer router may add a field, and the
 * contract is that unknown fields are ignored, never rejected, so the two
 * services can be deployed in either order.
 *
 * Money is integer USD cents (law #1) — never a float, never a string — and
 * a share quantity is a decimal string of at most nine places, Alpaca's own
 * fractional precision.
 */

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const PREV_PATTERN = /^(?:[0-9a-f]{64})?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WEIGHT_PATTERN = /^\d+(?:\.\d+)?$/;
const QUANTITY_PATTERN = /^-?\d+(?:\.\d{1,9})?$/;

export const SCHEMA_VERSION = 1;
export const MAX_JOURNAL_BATCH = 100;
/** A journal line is a plan, an order or a note; nothing the router writes comes near this. */
export const MAX_RAW_LINE_LENGTH = 65_536;
const MAX_POSITIONS = 100;
const MAX_ATTENTION_ITEMS = 20;

const idempotencyKey = z.string().trim().min(1).max(128);
const timestamp = z
  .string()
  .max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)), "must be an ISO-8601 timestamp");
const cents = z.number().int().safe();
const shortText = z.string().max(500);

const JournalEntrySchema = z.object({
  index: z.number().int().min(0).max(10_000_000),
  hash: z.string().regex(HASH_PATTERN, "hash must be a lowercase SHA-256 hex digest"),
  prev: z.string().regex(PREV_PATTERN, "prev must be empty or a SHA-256 hex digest"),
  raw: z.string().min(2).max(MAX_RAW_LINE_LENGTH),
});

export const JournalPayloadSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  kind: z.literal("journal"),
  idempotency_key: idempotencyKey,
  chain_id: z.string().regex(HASH_PATTERN, "chain_id must be a lowercase SHA-256 hex digest"),
  entries: z.array(JournalEntrySchema).min(1).max(MAX_JOURNAL_BATCH),
});

const PositionSchema = z.object({
  symbol: z.string().trim().min(1).max(12),
  qty: z.string().regex(QUANTITY_PATTERN, "qty must be a decimal with at most 9 places"),
  market_value_usd_cents: cents.nullable(),
  avg_entry_price_usd_cents: cents.nullable(),
  current_price_usd_cents: cents.nullable(),
});

const AccountSchema = z.object({
  taken_at: timestamp,
  equity_usd_cents: cents,
  cash_usd_cents: cents,
  last_equity_usd_cents: cents.nullable(),
  positions: z.array(PositionSchema).max(MAX_POSITIONS),
  targets: z
    .record(z.string().trim().min(1).max(12), z.string().regex(WEIGHT_PATTERN, "weight must be a plain decimal"))
    .refine((targets) => Object.keys(targets).length <= MAX_POSITIONS, "too many targets"),
});

const StatusSchema = z.object({
  trading_enabled: z.boolean(),
  disabled_reason: shortText.nullable(),
  halted: z.boolean(),
  halt_reason: shortText.nullable(),
  policy_sha256: z.string().regex(HASH_PATTERN).nullable(),
  policy_effective_from: z.string().regex(DATE_PATTERN).nullable(),
  plan: z
    .object({
      id: z.string().trim().min(1).max(64),
      kind: z.string().max(32),
      status: z.string().max(32),
      execute_on: z.string().regex(DATE_PATTERN),
    })
    .nullable(),
  journal: z.object({
    ok: z.boolean(),
    entries: z.number().int().min(0),
    reason: shortText.nullable(),
  }),
  tick_age_seconds: z.number().finite().min(0).nullable(),
  tick_failures: z.number().int().min(0),
  attention: z.array(shortText).max(MAX_ATTENTION_ITEMS),
});

export const ReportPayloadSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  kind: z.literal("report"),
  idempotency_key: idempotencyKey,
  reported_at: timestamp,
  status: StatusSchema,
  account: AccountSchema.nullable(),
});

export const CoreSyncPayloadSchema = z.discriminatedUnion("kind", [JournalPayloadSchema, ReportPayloadSchema]);

export type JournalPayload = z.infer<typeof JournalPayloadSchema>;
export type ReportPayload = z.infer<typeof ReportPayloadSchema>;
export type CoreSyncPayload = z.infer<typeof CoreSyncPayloadSchema>;
export type CoreAccountPayload = z.infer<typeof AccountSchema>;
export type CoreStatusPayload = z.infer<typeof StatusSchema>;
