import { createHash } from "node:crypto";
import { formatUsdDecimal } from "./core-format";
import { decimalToBasisPoints, formatDecimalTrimmed, sumProductsToCentsTruncated } from "./decimal-string";

/**
 * Everything this app knows how to do with a mirror of the long-term
 * core's journal — pure functions over already-fetched rows, the
 * `src/lib/` convention (AGENTS.md §3b): no database, no network, no
 * clock except where one is passed in.
 *
 * The core is a separate service (`~/paper-trader`'s `core_app`) that
 * trades its own Alpaca paper account and keeps an append-only,
 * hash-chained journal: one JSON line per step, each line carrying the
 * sha256 of the line before it. This app only ever holds a READ-ONLY copy
 * of that journal. Three consequences shape this file:
 *
 * 1. **The raw line is the record.** The mirror stores each journal line
 *    exactly as the router wrote it, plus the hash it claims. Everything
 *    else about an entry — its event, its time, which plan it belongs to,
 *    what it contained — is derived from that string, so there is one
 *    source of truth and nothing to drift. It also means this app can
 *    check the router's hash itself (`sha256(raw) === hash`) instead of
 *    taking it on trust.
 * 2. **A hash chain proves integrity, not authorship.** Anyone can compute
 *    sha256, so a chain that verifies says "nothing was altered since it
 *    was written", never "the router wrote it". Authorship is the HMAC on
 *    the request that delivered it (`/api/webhooks/core`).
 * 3. **Plans are derived, never stored.** The page's plan list and "what
 *    is open right now" are replayed from the journal on every read (law
 *    #5: derived truth), so a plan can never disagree with the journal it
 *    came from.
 *
 * Server-side only: `sha256Hex` uses `node:crypto`. Nothing in the client
 * bundle imports this file.
 */

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?$/;

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const asString = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const asDecimal = (value: unknown): string | null =>
  typeof value === "string" && DECIMAL_PATTERN.test(value) ? value : null;
const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const bySymbol = (a: { symbol: string }, b: { symbol: string }) => a.symbol.localeCompare(b.symbol);

/** A journal line as it travels and as it is stored. */
export type RawJournalEntry = { index: number; hash: string; prev: string; raw: string };

export type ParsedJournalEntry = {
  index: number;
  hash: string;
  prev: string;
  at: Date;
  event: string;
  planId: string | null;
  body: Json;
};

export type ParsedLine =
  | { ok: true; at: Date; event: string; prev: string; planId: string | null; body: Json }
  | { ok: false; code: "unreadable"; detail: string };

/**
 * Reads one journal line. Never throws: a line that is not a well-formed
 * entry is reported, because this runs over text that came off the wire.
 */
export function parseJournalLine(raw: string): ParsedLine {
  const fail = (detail: string): ParsedLine => ({ ok: false, code: "unreadable", detail });
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return fail("not valid JSON");
  }
  if (!isRecord(value)) return fail("not a JSON object");
  const { event, at, prev, plan_id: planId } = value;
  if (typeof event !== "string" || event.length === 0 || event.length > 100) return fail("no event name");
  if (typeof at !== "string") return fail("no timestamp");
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return fail("timestamp is not a date");
  if (typeof prev !== "string") return fail("no prev hash");
  return {
    ok: true,
    at: when,
    event,
    prev,
    planId: typeof planId === "string" && planId.length > 0 && planId.length <= 64 ? planId : null,
    body: value,
  };
}

/** Parses stored rows for display. A line that cannot be read stays in the list as an "unreadable" entry rather than vanishing: a gap in the record is itself something to see. */
export function parseStoredEntries(rows: readonly RawJournalEntry[]): ParsedJournalEntry[] {
  return rows.map((row) => {
    const parsed = parseJournalLine(row.raw);
    if (!parsed.ok) {
      return { index: row.index, hash: row.hash, prev: row.prev, at: new Date(0), event: "unreadable", planId: null, body: {} };
    }
    return {
      index: row.index,
      hash: row.hash,
      prev: row.prev,
      at: parsed.at,
      event: parsed.event,
      planId: parsed.planId,
      body: parsed.body,
    };
  });
}

// --- integrity -------------------------------------------------------------------------------------------

export type JournalProblemCode =
  | "bad_hash"
  | "unreadable"
  | "bad_prev"
  | "not_consecutive"
  | "broken_link"
  | "bad_genesis";

export type JournalProblem = { index: number; code: JournalProblemCode; detail: string };

/**
 * Whether a run of entries is internally sound: every hash is the sha256
 * of its own line, every line parses and agrees with the `prev` it was
 * delivered with, the indexes are consecutive, each entry's `prev` is the
 * previous entry's hash, and an entry at index 0 has an empty `prev`.
 * Returns every problem found (a batch is at most a few dozen entries).
 * It cannot say whether the run continues what is already stored — that is
 * `planJournalIngest`'s question.
 */
export function verifyJournalBatch(entries: readonly RawJournalEntry[]): JournalProblem[] {
  const problems: JournalProblem[] = [];
  entries.forEach((entry, position) => {
    const { index } = entry;
    const previous = position > 0 ? entries[position - 1] : null;

    if (previous && index !== previous.index + 1) {
      problems.push({ index, code: "not_consecutive", detail: `index ${index} does not follow ${previous.index}` });
    }
    if (!HASH_PATTERN.test(entry.hash) || sha256Hex(entry.raw) !== entry.hash) {
      problems.push({ index, code: "bad_hash", detail: "the line does not hash to the entry's hash" });
    }
    if (entry.prev !== "" && !HASH_PATTERN.test(entry.prev)) {
      problems.push({ index, code: "bad_prev", detail: "the declared prev is not a hash" });
    }
    const parsed = parseJournalLine(entry.raw);
    if (!parsed.ok) {
      problems.push({ index, code: "unreadable", detail: parsed.detail });
    } else if (parsed.prev !== entry.prev) {
      problems.push({ index, code: "bad_prev", detail: "the line's own prev differs from the one delivered with it" });
    }
    if (index === 0 && entry.prev !== "") {
      problems.push({ index, code: "bad_genesis", detail: "the first entry of a journal must have an empty prev" });
    }
    if (previous && entry.prev !== previous.hash) {
      problems.push({ index, code: "broken_link", detail: "the entry does not continue the previous entry" });
    }
  });
  return problems;
}

export type ChainVerdict =
  | { ok: true; entries: number; head: string }
  | { ok: false; atIndex: number; reason: string };

/**
 * Whether the mirror, read back from storage, is a whole and unaltered
 * chain from the journal's first entry. Names the first entry at which it
 * stops being one. An empty mirror is intact: there is nothing to dispute.
 */
export function verifyJournalChain(entries: readonly RawJournalEntry[]): ChainVerdict {
  if (entries.length === 0) return { ok: true, entries: 0, head: "" };
  const problems = verifyJournalBatch(entries);
  if (entries[0].index !== 0) {
    problems.push({
      index: entries[0].index,
      code: "bad_genesis",
      detail: "the mirror does not start at the journal's first entry",
    });
  }
  if (problems.length > 0) {
    const first = problems.reduce((earliest, candidate) => (candidate.index < earliest.index ? candidate : earliest));
    return { ok: false, atIndex: first.index, reason: first.detail };
  }
  return { ok: true, entries: entries.length, head: entries[entries.length - 1].hash };
}

// --- ingest ----------------------------------------------------------------------------------------------

export type IngestPlan =
  | { type: "append"; toInsert: RawJournalEntry[]; duplicates: number; nextIndex: number }
  | { type: "duplicate"; duplicates: number; nextIndex: number }
  | { type: "gap"; nextIndex: number }
  | { type: "conflict"; index: number; detail: string }
  | { type: "invalid"; detail: string };

/**
 * What to do with a verified batch, given what is already stored for its
 * chain. Pure: the caller reads the stored head and the stored hashes for
 * the indexes the batch overlaps, and acts on the answer.
 *
 * - **append**: new entries that continue what is stored (or start the chain).
 * - **duplicate**: everything in the batch is already held, byte for byte.
 * - **gap**: the batch starts beyond what is held — a restored database, say.
 *   Answered with where the mirror actually is, so the sender can rewind;
 *   storing the batch would leave a hole in the chain.
 * - **conflict**: the mirror already holds a *different* entry at an index,
 *   or the batch does not continue the stored head. Two versions of one
 *   entry must never coexist, so nothing is stored.
 * - **invalid**: the batch contradicts itself (a chain whose first entry is
 *   not its own id).
 */
export function planJournalIngest(input: {
  chainId: string;
  storedHeadIndex: number | null;
  storedHeadHash: string | null;
  storedOverlap: ReadonlyMap<number, string>;
  batch: readonly RawJournalEntry[];
}): IngestPlan {
  const { chainId, storedHeadIndex, storedHeadHash, storedOverlap, batch } = input;
  if (batch.length === 0) return { type: "invalid", detail: "an empty batch" };

  const first = batch[0];
  const nextIndex = storedHeadIndex === null ? 0 : storedHeadIndex + 1;

  if (first.index === 0 && first.hash !== chainId) {
    return { type: "invalid", detail: "the first entry's hash must be the chain id" };
  }
  if (first.index > nextIndex) return { type: "gap", nextIndex };

  let duplicates = 0;
  const toInsert: RawJournalEntry[] = [];
  for (const entry of batch) {
    if (entry.index >= nextIndex) {
      toInsert.push(entry);
      continue;
    }
    const stored = storedOverlap.get(entry.index);
    if (stored === undefined) {
      return { type: "conflict", index: entry.index, detail: "the mirror has no entry at an index it should hold" };
    }
    if (stored !== entry.hash) {
      return { type: "conflict", index: entry.index, detail: "the mirror already holds a different entry at this index" };
    }
    duplicates += 1;
  }

  if (toInsert.length === 0) return { type: "duplicate", duplicates, nextIndex };

  const expectedPrev = nextIndex === 0 ? "" : storedHeadHash;
  if (toInsert[0].prev !== expectedPrev) {
    return { type: "conflict", index: toInsert[0].index, detail: "the entry does not continue the mirror's last entry" };
  }
  return { type: "append", toInsert, duplicates, nextIndex: toInsert[toInsert.length - 1].index + 1 };
}

// --- plans -----------------------------------------------------------------------------------------------

export type CorePlanStatus =
  | "awaiting_approval"
  | "approved"
  | "selling"
  | "buying"
  | "done"
  | "abandoned"
  | "expired"
  | "deferred"
  | "halted"
  | "superseded"
  | "rejected";

/** A plan in one of these is still being worked on: the owner may owe it an approval, or orders may be live. */
export const OPEN_PLAN_STATUSES: readonly CorePlanStatus[] = ["awaiting_approval", "approved", "selling", "buying"];

export type CorePlanOrder = {
  clientOrderId: string;
  symbol: string;
  side: string;
  status: string;
  notionalUsd: string | null;
  qty: string | null;
  limitPrice: string | null;
  filledQty: string | null;
  filledAvgPrice: string | null;
  error: string | null;
};

export type CorePlan = {
  id: string;
  kind: string;
  status: CorePlanStatus;
  decidedOn: string | null;
  executeOn: string | null;
  redecision: boolean;
  /** The Allocator's reason for the plan ("initial", "quarterly", …). */
  reason: string | null;
  /** The router's own words for why a closed plan ended as it did. */
  outcome: string | null;
  sells: { symbol: string; qty: string }[];
  buys: { symbol: string; notionalUsd: string }[];
  orders: CorePlanOrder[];
  acceptedAt: Date;
  approvedAt: Date | null;
  closedAt: Date | null;
  /** The plan was approved with the owner's signed fund command (the initial build). */
  fundedByOwner: boolean;
  /** Dollars actually filled, in cents, truncated the way the router records it; null until the plan closes. */
  tradedUsdCents: number | null;
  notes: string[];
  problems: string[];
};

const CLOSING_EVENTS: Readonly<Record<string, CorePlanStatus>> = {
  plan_done: "done",
  plan_abandoned: "abandoned",
  plan_expired: "expired",
  plan_deferred: "deferred",
  plan_halted: "halted",
};

function readPlanBlock(raw: unknown): Pick<CorePlan, "decidedOn" | "reason" | "sells" | "buys"> {
  const block = isRecord(raw) ? raw : {};
  const entriesOf = (value: unknown) => Object.entries(isRecord(value) ? value : {});
  return {
    decidedOn: asString(block.decided_on),
    reason: asString(block.reason),
    sells: entriesOf(block.sells)
      .flatMap(([symbol, qty]) => {
        const decimal = asDecimal(qty);
        return decimal ? [{ symbol, qty: decimal }] : [];
      })
      .sort(bySymbol),
    buys: entriesOf(block.buys)
      .flatMap(([symbol, notional]) => {
        const decimal = asDecimal(notional);
        return decimal ? [{ symbol, notionalUsd: decimal }] : [];
      })
      .sort(bySymbol),
  };
}

function newPlan(id: string, entry: ParsedJournalEntry, status: CorePlanStatus): CorePlan {
  const block = readPlanBlock(entry.body.plan);
  return {
    id,
    kind: asString(entry.body.kind) ?? "rebalance",
    status,
    decidedOn: block.decidedOn,
    executeOn: asString(entry.body.execute_on),
    redecision: entry.body.redecision === true,
    reason: block.reason,
    outcome: null,
    sells: block.sells,
    buys: block.buys,
    orders: [],
    acceptedAt: entry.at,
    approvedAt: null,
    closedAt: null,
    fundedByOwner: false,
    tradedUsdCents: null,
    notes: [],
    problems: [],
  };
}

function orderFromPayload(payload: unknown, status: string): CorePlanOrder | null {
  if (!isRecord(payload)) return null;
  const symbol = asString(payload.symbol);
  const side = asString(payload.side);
  const clientOrderId = asString(payload.client_order_id);
  if (!symbol || !side || !clientOrderId) return null;
  return {
    clientOrderId,
    symbol,
    side,
    status,
    notionalUsd: asDecimal(payload.notional),
    qty: asDecimal(payload.qty),
    limitPrice: asDecimal(payload.limit_price),
    filledQty: null,
    filledAvgPrice: null,
    error: null,
  };
}

function orderFromRecord(clientOrderId: string, raw: unknown): CorePlanOrder | null {
  if (!isRecord(raw)) return null;
  const payload = isRecord(raw.payload) ? raw.payload : {};
  const symbol = asString(raw.symbol) ?? asString(payload.symbol);
  const side = asString(raw.side) ?? asString(payload.side);
  if (!symbol || !side) return null;
  return {
    clientOrderId,
    symbol,
    side,
    status: asString(raw.status) ?? "unknown",
    notionalUsd: asDecimal(payload.notional),
    qty: asDecimal(payload.qty),
    limitPrice: asDecimal(payload.limit_price),
    filledQty: asDecimal(raw.filled_qty),
    filledAvgPrice: asDecimal(raw.filled_avg_price),
    error: asString(raw.error),
  };
}

/** Sells before buys, then by symbol: the journal sorts its keys, so a closing entry's orders arrive in client-id order, which is neither. */
function sortOrders(orders: CorePlanOrder[]): CorePlanOrder[] {
  const rank = (side: string) => (side === "sell" ? 0 : 1);
  return [...orders].sort(
    (a, b) => rank(a.side) - rank(b.side) || a.symbol.localeCompare(b.symbol) || a.clientOrderId.localeCompare(b.clientOrderId),
  );
}

function tradedUsdCents(orders: readonly CorePlanOrder[]): number {
  const pairs: [string, string][] = [];
  for (const order of orders) {
    if (order.filledQty && order.filledAvgPrice && /[1-9]/.test(order.filledQty)) {
      pairs.push([order.filledQty, order.filledAvgPrice]);
    }
  }
  return sumProductsToCentsTruncated(pairs);
}

/**
 * Replays the journal into the plans it describes, oldest first.
 *
 * A plan's id is content-addressed in the router (the same decision from
 * the same inputs has the same id), so a plan proposed again after it
 * closed starts a NEW lifecycle under the same id rather than reopening
 * the old one; later events apply to the most recent plan with that id.
 * The closing entry carries the plan's final orders and is authoritative
 * for them. Events about a plan this replay never saw, and bodies of an
 * unexpected shape, are skipped: the page must render whatever the router
 * wrote, including something newer than this code understands.
 */
export function deriveCorePlans(entries: readonly ParsedJournalEntry[]): CorePlan[] {
  const plans: CorePlan[] = [];
  const latest = new Map<string, CorePlan>();
  const register = (plan: CorePlan) => {
    plans.push(plan);
    latest.set(plan.id, plan);
    return plan;
  };

  for (const entry of entries) {
    const body = entry.body;
    const pid = entry.planId;
    const plan = pid ? latest.get(pid) : undefined;

    const closing = CLOSING_EVENTS[entry.event];
    if (closing) {
      const target = plan ?? (pid ? register(newPlan(pid, entry, closing)) : undefined);
      if (!target) continue;
      target.status = closing;
      target.closedAt = entry.at;
      target.outcome = asString(body.reason);
      target.kind = asString(body.kind) ?? target.kind;
      const finals = isRecord(body.orders)
        ? Object.entries(body.orders).flatMap(([cid, raw]) => {
            const order = orderFromRecord(cid, raw);
            return order ? [order] : [];
          })
        : [];
      if (finals.length > 0) target.orders = sortOrders(finals);
      target.tradedUsdCents = tradedUsdCents(target.orders);
      continue;
    }

    switch (entry.event) {
      case "plan_accepted": {
        if (!pid) break;
        register(newPlan(pid, entry, body.status === "awaiting_approval" ? "awaiting_approval" : "approved"));
        break;
      }
      case "plan_approved": {
        if (!plan) break;
        if (plan.status === "awaiting_approval") plan.status = "approved";
        plan.approvedAt = entry.at;
        plan.fundedByOwner = body.fund === true;
        break;
      }
      case "order_submitted": {
        if (!plan) break;
        const order = orderFromPayload(body.payload, asString(body.alpaca_status) ?? "submitted");
        if (!order) break;
        plan.orders = sortOrders([...plan.orders.filter((o) => o.clientOrderId !== order.clientOrderId), order]);
        if (plan.status === "approved" || plan.status === "selling") {
          plan.status = order.side === "sell" ? "selling" : "buying";
        }
        break;
      }
      case "order_rejected": {
        if (!plan) break;
        const symbol = asString(body.symbol);
        const side = asString(body.side);
        if (!symbol || !side) break;
        plan.orders = sortOrders([
          ...plan.orders,
          {
            clientOrderId: `${plan.id}-${symbol}-${side}`,
            symbol,
            side,
            status: "rejected",
            notionalUsd: null,
            qty: null,
            limitPrice: null,
            filledQty: null,
            filledAvgPrice: null,
            error: asString(body.error),
          },
        ]);
        break;
      }
      case "sells_cancelled_at_deadline":
        plan?.notes.push("Sells did not fill in time and were cancelled");
        break;
      case "buys_cancelled_at_deadline":
        plan?.notes.push("Buys did not fill in time and were cancelled");
        break;
      case "buy_blocked":
        plan?.notes.push(`Buys blocked: ${asString(body.code) ?? "unknown"}: ${asString(body.detail) ?? "no detail"}`);
        break;
      case "plan_superseded": {
        if (!plan) break;
        const by = asString(body.by);
        plan.status = "superseded";
        plan.closedAt = entry.at;
        plan.outcome = by ? `Replaced by plan ${shortId(by)}` : "Replaced by a newer plan";
        break;
      }
      case "plan_rejected": {
        const id = pid ?? `rejected-${entry.hash.slice(0, 8)}`;
        const rejected = register(newPlan(id, entry, "rejected"));
        rejected.closedAt = entry.at;
        rejected.problems = asStrings(body.problems);
        break;
      }
      default:
        break;
    }
  }
  return plans;
}

/** The most recent plan that is still open, if any. */
export function findOpenPlan(plans: readonly CorePlan[]): CorePlan | null {
  for (let i = plans.length - 1; i >= 0; i -= 1) {
    if (OPEN_PLAN_STATUSES.includes(plans[i].status)) return plans[i];
  }
  return null;
}

// --- describing events -----------------------------------------------------------------------------------

export type EventTone = "positive" | "warning" | "critical" | "neutral";
export type DescribedEvent = { label: string; detail: string | null; tone: EventTone };

const DETAIL_MAX_LENGTH = 240;

export const shortId = (id: string, length = 8): string => id.slice(0, length);

function clip(text: string): string {
  return text.length <= DETAIL_MAX_LENGTH ? text : `${text.slice(0, DETAIL_MAX_LENGTH - 1)}…`;
}

function capitalise(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

/**
 * A one-line, plain-text summary of a journal entry for the feed. Returns
 * strings only — whatever the router put in a field is passed through
 * (bounded in length) and left for the renderer, which escapes it, to deal
 * with; nothing here builds markup.
 */
export function describeCoreEvent(entry: ParsedJournalEntry): DescribedEvent {
  const body = entry.body;
  const plan = shortId(entry.planId ?? "");
  const closing = CLOSING_EVENTS[entry.event];

  if (closing === "done") {
    const orders = isRecord(body.orders) ? Object.values(body.orders).filter(isRecord) : [];
    const unfilled = orders.filter((order) => order.status !== "filled").length;
    return {
      label: `Plan ${plan} done`,
      detail: orders.length === 0 ? null : unfilled > 0 ? `${unfilled} of ${orders.length} orders did not fill` : `${orders.length} orders filled`,
      tone: unfilled > 0 ? "warning" : "positive",
    };
  }
  if (closing) {
    return {
      label: `Plan ${plan} ${closing}`,
      detail: asString(body.reason) ? clip(asString(body.reason) as string) : null,
      tone: closing === "halted" ? "critical" : "warning",
    };
  }

  switch (entry.event) {
    case "started":
      return { label: "Router started", detail: null, tone: "neutral" };
    case "plan_accepted": {
      const awaiting = body.status === "awaiting_approval";
      const parts = [
        `${asString(body.kind) ?? "plan"}${body.redecision === true ? " (re-decision)" : ""}`,
        asString(body.execute_on) ? `executes ${asString(body.execute_on)}` : null,
        awaiting ? "needs your approval" : null,
      ].filter(Boolean);
      return { label: `Plan ${plan} proposed`, detail: clip(parts.join(" · ")), tone: awaiting ? "warning" : "neutral" };
    }
    case "plan_approved":
      return {
        label: `Plan ${plan} approved`,
        detail: body.fund === true ? "with the signed fund command" : null,
        tone: "positive",
      };
    case "order_submitted": {
      const payload = isRecord(body.payload) ? body.payload : {};
      const side = asString(payload.side);
      const symbol = asString(payload.symbol);
      const notional = asDecimal(payload.notional);
      const qty = asDecimal(payload.qty);
      const amount = notional ? formatUsdDecimal(notional) : qty ? `${formatDecimalTrimmed(qty)} sh` : null;
      const status = asString(body.alpaca_status);
      return {
        label: side && symbol ? `Order sent: ${side} ${symbol}` : "Order sent",
        detail: clip([amount, status].filter(Boolean).join(" · ")) || null,
        tone: "neutral",
      };
    }
    case "order_rejected":
      return {
        label: `Alpaca refused ${asString(body.side) ?? "an order"} ${asString(body.symbol) ?? ""}`.trim(),
        detail: asString(body.error) ? clip(asString(body.error) as string) : null,
        tone: "critical",
      };
    case "plan_superseded":
      return {
        label: `Plan ${plan} replaced`,
        detail: asString(body.by) ? `by plan ${shortId(asString(body.by) as string)}` : null,
        tone: "neutral",
      };
    case "plan_rejected": {
      const problems = asStrings(body.problems);
      return { label: "Plan broke a limit", detail: problems.length ? clip(problems.join("; ")) : null, tone: "critical" };
    }
    case "plan_mismatch":
      return {
        label: "Router disagreed with the Allocator",
        detail: asString(body.session) ? `session ${asString(body.session)}` : null,
        tone: "critical",
      };
    case "no_plan":
      return {
        label: `No plan for ${asString(body.session) ?? "that session"}`,
        detail: asString(body.reason) ? clip(asString(body.reason) as string) : null,
        tone: "neutral",
      };
    case "tick_failed": {
      const count = typeof body.consecutive === "number" ? `${body.consecutive} in a row` : null;
      const error = asString(body.error);
      return {
        label: "Execution loop failing",
        detail: clip([count, error].filter(Boolean).join(": ")) || null,
        tone: "critical",
      };
    }
    case "sells_cancelled_at_deadline":
      return { label: "Sells did not fill in time", detail: null, tone: "warning" };
    case "buys_cancelled_at_deadline":
      return { label: "Buys did not fill in time", detail: null, tone: "warning" };
    case "buy_blocked":
      return {
        label: "Buys blocked",
        detail: clip([asString(body.code), asString(body.detail)].filter(Boolean).join(": ")) || null,
        tone: "warning",
      };
    case "journal_invalid":
      return { label: "Journal failed its integrity check", detail: asString(body.reason), tone: "critical" };
    default:
      return { label: capitalise(entry.event.replace(/_/g, " ")), detail: null, tone: "neutral" };
  }
}

// --- the account -----------------------------------------------------------------------------------------

export type CorePositionInput = {
  symbol: string;
  qty: string;
  marketValueUsdCents: number | null;
  avgEntryPriceUsdCents: number | null;
  currentPriceUsdCents: number | null;
};

export type CoreAllocationRow = {
  symbol: string;
  qty: string;
  marketValueUsdCents: number | null;
  targetBps: number | null;
  actualBps: number | null;
  driftBps: number | null;
};

export type CoreAllocation = {
  rows: CoreAllocationRow[];
  cashBps: number | null;
  investedUsdCents: number;
};

/**
 * `part / whole` as basis points, rounded half away from zero, in exact
 * integer arithmetic; null when there is no whole to be a share of. `part`
 * may be negative (a day's change), and rounds symmetrically: -0.5 bp is
 * -1 bp, as +0.5 bp is +1 bp.
 */
export function shareInBps(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  const magnitude = BigInt(Math.abs(part));
  const rounded = Number((magnitude * 20_000n + BigInt(whole)) / (2n * BigInt(whole)));
  return part < 0 ? -rounded : rounded;
}

function weightToBps(weight: string): number | null {
  try {
    return decimalToBasisPoints(weight);
  } catch {
    return null;
  }
}

/**
 * Each holding's share of the account against its target. Shares are of
 * total equity (positions plus cash), because that is what the policy's
 * weights are weights of. A target the account holds none of is a row at
 * zero; a holding with no target is a row with no drift. A position the
 * broker gave no market value for has no share — nothing is estimated.
 */
export function computeCoreAllocation(input: {
  equityUsdCents: number;
  cashUsdCents: number;
  positions: readonly CorePositionInput[];
  targets: Readonly<Record<string, string>>;
}): CoreAllocation {
  const { equityUsdCents, cashUsdCents, positions, targets } = input;
  const targetBps = new Map<string, number>();
  for (const [symbol, weight] of Object.entries(targets)) {
    const bps = weightToBps(weight);
    if (bps !== null) targetBps.set(symbol, bps);
  }

  const held = new Map(positions.map((position) => [position.symbol, position]));
  const symbols = new Set([...targetBps.keys(), ...held.keys()]);

  const rows: CoreAllocationRow[] = [...symbols].map((symbol) => {
    const position = held.get(symbol);
    const marketValueUsdCents = position ? position.marketValueUsdCents : 0;
    const target = targetBps.get(symbol) ?? null;
    const actual = marketValueUsdCents === null ? null : shareInBps(marketValueUsdCents, equityUsdCents);
    return {
      symbol,
      qty: position ? position.qty : "0",
      marketValueUsdCents,
      targetBps: target,
      actualBps: actual,
      driftBps: actual !== null && target !== null ? actual - target : null,
    };
  });

  rows.sort((a, b) => {
    if ((a.targetBps === null) !== (b.targetBps === null)) return a.targetBps === null ? 1 : -1;
    if (a.targetBps !== null && b.targetBps !== null && a.targetBps !== b.targetBps) return b.targetBps - a.targetBps;
    return a.symbol.localeCompare(b.symbol);
  });

  return {
    rows,
    cashBps: shareInBps(cashUsdCents, equityUsdCents),
    investedUsdCents: positions.reduce((sum, position) => sum + (position.marketValueUsdCents ?? 0), 0),
  };
}

// --- the router's heartbeat ------------------------------------------------------------------------------

export type RouterFreshness = "fresh" | "stale" | "silent" | "never";

const FRESH_SECONDS = 15 * 60;
const STALE_SECONDS = 24 * 60 * 60;

/**
 * How recently the router last reported. The router reports every few
 * minutes while it runs, so "fresh" is a quarter of an hour. "Stale" runs
 * to a day and is deliberately not alarming — a router on a laptop is off
 * overnight; only a day of silence is "silent".
 */
export function routerFreshness(reportedAt: Date | null, now: Date): { state: RouterFreshness; ageSeconds: number | null } {
  if (!reportedAt) return { state: "never", ageSeconds: null };
  const ageSeconds = Math.max(0, Math.round((now.getTime() - reportedAt.getTime()) / 1000));
  if (ageSeconds <= FRESH_SECONDS) return { state: "fresh", ageSeconds };
  if (ageSeconds <= STALE_SECONDS) return { state: "stale", ageSeconds };
  return { state: "silent", ageSeconds };
}
