import { NextRequest } from "next/server";
import { sha256Hex, type RawJournalEntry } from "../../src/lib/core-journal";
import {
  IDEMPOTENCY_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  computeWebhookSignature,
} from "../../src/lib/webhook-signature";

/**
 * Builders shared by every test of the long-term core's mirror (the
 * schema, the DAL, the route). They produce the SHAPES the trader's
 * `risk_router/core_sync.py` sends and its `Journal.write` writes —
 * `json.dumps(entry, sort_keys=True)` with its spaces after commas and
 * colons, each entry's `prev` the sha256 of the previous line — so the
 * tests exercise the real wire format, not a tidier invented one. The
 * authoritative check that the two repositories agree is the contract
 * fixture (`tests/fixtures/core-sync-contract.json`, produced by the
 * trader's own code), replayed in `core-webhook-route.test.ts`.
 */

export const POLICY_SHA = "4f3c".repeat(16);
export const PLAN_ID = "a1b2c3d4e5f60718";
// Repeated characters on purpose: zero entropy, so no secret scanner mistakes a fixture for a real key.
export const WEBHOOK_SECRET_FOR_TESTS = "t".repeat(40);
export const OTHER_SECRET_FOR_TESTS = "u".repeat(40);

/** Python's `json.dumps(value, sort_keys=True)`: keys sorted at every level, ", " and ": " separators. */
export function pyJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pyJson).join(", ")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}: ${pyJson(record[key])}`)
    .join(", ")}}`;
}

export type JournalSpec = { event: string; detail?: Record<string, unknown>; at?: string };

/** A hash-linked run of journal entries, one minute apart starting at `startAt`. */
export function buildChain(specs: JournalSpec[], startAt = new Date("2026-10-05T13:00:00.000Z")): RawJournalEntry[] {
  const out: RawJournalEntry[] = [];
  let prev = "";
  specs.forEach((spec, index) => {
    const at = spec.at ?? `${new Date(startAt.getTime() + index * 60_000).toISOString().replace("Z", "")}000+00:00`;
    const raw = pyJson({ at, event: spec.event, policy_sha256: POLICY_SHA, prev, ...spec.detail });
    const hash = sha256Hex(raw);
    out.push({ index, hash, prev, raw });
    prev = hash;
  });
  return out;
}

export const INITIAL_PLAN = {
  decided_on: "2026-10-02",
  reason: "initial",
  targets: { BIL: "0.05", BND: "0.19", IAU: "0.19", VNQ: "0.19", VTI: "0.19", VXUS: "0.19" },
  sells: {},
  buys: { BIL: "499.95", VTI: "1899.81" },
};

export function buyPayload(symbol: string, notional: string, pid = PLAN_ID) {
  return {
    symbol,
    side: "buy",
    type: "limit",
    time_in_force: "day",
    notional,
    limit_price: "101.50",
    client_order_id: `core-${pid}-${symbol}-b`,
    extended_hours: false,
  };
}

/** The initial build of the owner's policy, from start-up to `done`: six entries. */
export function initialBuildSpecs(pid = PLAN_ID): JournalSpec[] {
  return [
    { event: "started", detail: { account: "PA0CORE00001" } },
    {
      event: "plan_accepted",
      detail: {
        plan_id: pid,
        kind: "initial",
        status: "awaiting_approval",
        plan: INITIAL_PLAN,
        execute_on: "2026-10-05",
        redecision: false,
      },
    },
    { event: "plan_approved", detail: { plan_id: pid, fund: true } },
    { event: "order_submitted", detail: { plan_id: pid, payload: buyPayload("VTI", "1899.81", pid), alpaca_status: "accepted" } },
    { event: "order_submitted", detail: { plan_id: pid, payload: buyPayload("BIL", "499.95", pid), alpaca_status: "accepted" } },
    {
      event: "plan_done",
      detail: {
        plan_id: pid,
        kind: "initial",
        reason: null,
        orders: {
          [`core-${pid}-VTI-b`]: {
            symbol: "VTI",
            side: "buy",
            status: "filled",
            payload: buyPayload("VTI", "1899.81", pid),
            filled_qty: "18.5",
            filled_avg_price: "102.69",
          },
          [`core-${pid}-BIL-b`]: {
            symbol: "BIL",
            side: "buy",
            status: "filled",
            payload: buyPayload("BIL", "499.95", pid),
            filled_qty: "5.4",
            filled_avg_price: "91.00",
          },
        },
      },
    },
  ];
}

export function journalPayload(chainId: string, entries: readonly RawJournalEntry[], idempotencyKey?: string) {
  const first = entries[0].index;
  const last = entries[entries.length - 1].index;
  return {
    schema_version: 1 as const,
    kind: "journal" as const,
    idempotency_key: idempotencyKey ?? `core-journal:${chainId.slice(0, 16)}:${first}-${last}`,
    chain_id: chainId,
    entries: entries.map((entry) => ({ index: entry.index, hash: entry.hash, prev: entry.prev, raw: entry.raw })),
  };
}

export const DEFAULT_POSITIONS = [
  { symbol: "VTI", qty: "18.5", market_value_usd_cents: 190_000, avg_entry_price_usd_cents: 10_269, current_price_usd_cents: 10_270 },
  { symbol: "VXUS", qty: "30.1", market_value_usd_cents: 190_000, avg_entry_price_usd_cents: 6_310, current_price_usd_cents: 6_312 },
  { symbol: "BND", qty: "26.0", market_value_usd_cents: 190_000, avg_entry_price_usd_cents: 7_300, current_price_usd_cents: 7_308 },
  { symbol: "IAU", qty: "30.0", market_value_usd_cents: 190_000, avg_entry_price_usd_cents: 6_330, current_price_usd_cents: 6_333 },
  { symbol: "VNQ", qty: "20.8", market_value_usd_cents: 190_000, avg_entry_price_usd_cents: 9_130, current_price_usd_cents: 9_135 },
  { symbol: "BIL", qty: "5.4", market_value_usd_cents: 49_900, avg_entry_price_usd_cents: 9_100, current_price_usd_cents: 9_240 },
];

export const DEFAULT_TARGETS = { BIL: "0.05", BND: "0.19", IAU: "0.19", VNQ: "0.19", VTI: "0.19", VXUS: "0.19" };

export function reportPayload(
  over: { reportedAt?: string; status?: Record<string, unknown>; account?: Record<string, unknown> | null } = {},
) {
  const reportedAt = over.reportedAt ?? "2026-10-05T14:00:00.000Z";
  return {
    schema_version: 1 as const,
    kind: "report" as const,
    idempotency_key: `core-report:${reportedAt}`,
    reported_at: reportedAt,
    status: {
      trading_enabled: true,
      disabled_reason: null,
      halted: false,
      halt_reason: null,
      policy_sha256: POLICY_SHA,
      policy_effective_from: "2026-10-05",
      plan: null,
      journal: { ok: true, entries: 6, reason: null },
      tick_age_seconds: 4.2,
      tick_failures: 0,
      attention: [] as string[],
      ...over.status,
    },
    account:
      over.account === null
        ? null
        : {
            taken_at: reportedAt,
            equity_usd_cents: 1_000_000,
            cash_usd_cents: 100,
            last_equity_usd_cents: 999_000,
            positions: DEFAULT_POSITIONS,
            targets: DEFAULT_TARGETS,
            ...over.account,
          },
  };
}

/** A signed POST to the webhook, built the way the trader's `core_sync` builds one. */
export function signedRequest(
  payload: unknown,
  options: { secret?: string; timestamp?: string; signature?: string; body?: string; idempotencyKey?: string } = {},
): NextRequest {
  const body = options.body ?? JSON.stringify(payload);
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature =
    options.signature ?? `sha256=${computeWebhookSignature(body, timestamp, options.secret ?? WEBHOOK_SECRET_FOR_TESTS)}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [TIMESTAMP_HEADER]: timestamp,
    [SIGNATURE_HEADER]: signature,
  };
  if (options.idempotencyKey) headers[IDEMPOTENCY_HEADER] = options.idempotencyKey;
  return new NextRequest("http://localhost:3000/api/webhooks/core", { method: "POST", headers, body });
}
