import { describe, expect, it } from "vitest";
import {
  computeCoreAllocation,
  deriveCorePlans,
  describeCoreEvent,
  findOpenPlan,
  parseJournalLine,
  parseStoredEntries,
  planJournalIngest,
  routerFreshness,
  sha256Hex,
  shareInBps,
  verifyJournalBatch,
  verifyJournalChain,
  type RawJournalEntry,
} from "./core-journal";

/**
 * The fixtures below are built the way the trader builds them
 * (`Journal.write`: `json.dumps(entry, sort_keys=True, default=str)` — a
 * space after every comma and colon — then each entry's `prev` is the
 * sha256 of the previous line), so these tests exercise the real shape,
 * not a tidier invented one.
 */
const POLICY_SHA = "4f3c".repeat(16);
const PID = "a1b2c3d4e5f60718";
const PID_B = "0f9e8d7c6b5a4321";

function pyJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pyJson).join(", ")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}: ${pyJson(record[key])}`)
    .join(", ")}}`;
}

type Spec = { event: string; detail?: Record<string, unknown>; at?: string };

function buildChain(specs: Spec[]): RawJournalEntry[] {
  const out: RawJournalEntry[] = [];
  let prev = "";
  specs.forEach((spec, index) => {
    const at = spec.at ?? `2026-10-05T13:${String(index).padStart(2, "0")}:00.123456+00:00`;
    const raw = pyJson({ at, event: spec.event, policy_sha256: POLICY_SHA, prev, ...spec.detail });
    const hash = sha256Hex(raw);
    out.push({ index, hash, prev, raw });
    prev = hash;
  });
  return out;
}

const INITIAL_PLAN = {
  decided_on: "2026-10-02",
  reason: "initial",
  targets: { BIL: "0.05", BND: "0.19", IAU: "0.19", VNQ: "0.19", VTI: "0.19", VXUS: "0.19" },
  sells: {},
  buys: { BIL: "499.95", VTI: "1899.81" },
};

function buyPayload(symbol: string, notional: string, pid = PID) {
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

function sellPayload(symbol: string, qty: string, pid = PID) {
  return {
    symbol,
    side: "sell",
    type: "limit",
    time_in_force: "day",
    qty,
    limit_price: "97.00",
    client_order_id: `core-${pid}-${symbol}-s`,
    extended_hours: false,
  };
}

const accepted = (pid = PID, over: Record<string, unknown> = {}): Spec => ({
  event: "plan_accepted",
  detail: {
    plan_id: pid,
    kind: "initial",
    status: "awaiting_approval",
    plan: INITIAL_PLAN,
    execute_on: "2026-10-05",
    redecision: false,
    ...over,
  },
});

function done(pid = PID, status = "done", orders: Record<string, unknown> = {}, reason: string | null = null): Spec {
  return { event: `plan_${status}`, detail: { plan_id: pid, kind: "initial", reason, orders } };
}

function filledOrders() {
  return {
    [`core-${PID}-VTI-b`]: {
      symbol: "VTI",
      side: "buy",
      status: "filled",
      payload: buyPayload("VTI", "1899.81"),
      filled_qty: "18.5",
      filled_avg_price: "102.69",
    },
    [`core-${PID}-BIL-b`]: {
      symbol: "BIL",
      side: "buy",
      status: "filled",
      payload: buyPayload("BIL", "499.95"),
      filled_qty: "5.4",
      filled_avg_price: "91.00",
    },
  };
}

describe("parseJournalLine", () => {
  it("reads the trader's own line format", () => {
    const [entry] = buildChain([{ event: "plan_approved", detail: { plan_id: PID, fund: true } }]);
    const parsed = parseJournalLine(entry.raw);
    expect(parsed).toMatchObject({ ok: true, event: "plan_approved", planId: PID, prev: "" });
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.at.toISOString()).toBe("2026-10-05T13:00:00.123Z");
    expect(parsed.body.fund).toBe(true);
  });

  it("takes a plan id only from a string plan_id", () => {
    const [entry] = buildChain([{ event: "x", detail: { plan_id: 5 } }]);
    expect(parseJournalLine(entry.raw)).toMatchObject({ ok: true, planId: null });
  });

  it.each([
    ["not json", "{nope"],
    ["a json array", "[1, 2]"],
    ["a json string", '"hello"'],
    ["no event", '{"at": "2026-10-05T13:00:00+00:00", "prev": ""}'],
    ["an empty event", '{"at": "2026-10-05T13:00:00+00:00", "event": "", "prev": ""}'],
    ["no timestamp", '{"event": "started", "prev": ""}'],
    ["a timestamp that is not one", '{"at": "yesterday-ish", "event": "started", "prev": ""}'],
    ["no prev", '{"at": "2026-10-05T13:00:00+00:00", "event": "started"}'],
    ["a prev that is not a string", '{"at": "2026-10-05T13:00:00+00:00", "event": "started", "prev": 7}'],
  ])("refuses %s", (_label, raw) => {
    expect(parseJournalLine(raw)).toMatchObject({ ok: false });
  });
});

describe("verifyJournalBatch", () => {
  const chain = buildChain([{ event: "started" }, accepted(), { event: "plan_approved", detail: { plan_id: PID } }]);

  it("accepts a well-formed chain", () => {
    expect(verifyJournalBatch(chain)).toEqual([]);
  });

  it("accepts a batch that starts mid-chain, so long as it links to itself", () => {
    expect(verifyJournalBatch(chain.slice(1))).toEqual([]);
  });

  it("flags a line that no longer matches its hash", () => {
    const tampered = chain.map((e) => ({ ...e }));
    tampered[1].raw = tampered[1].raw.replace("awaiting_approval", "approved");
    expect(verifyJournalBatch(tampered)).toEqual([expect.objectContaining({ index: 1, code: "bad_hash" })]);
  });

  it("flags a declared prev that differs from the one inside the line", () => {
    const tampered = chain.map((e) => ({ ...e }));
    tampered[2].prev = "f".repeat(64);
    const codes = verifyJournalBatch(tampered).map((p) => p.code);
    expect(codes).toContain("bad_prev");
  });

  it("flags a link that does not continue the previous entry", () => {
    const stranger = buildChain([{ event: "started", at: "2026-10-04T10:00:00.000000+00:00" }, { event: "other" }]);
    const spliced = [chain[0], { ...stranger[1], index: 1 }];
    expect(verifyJournalBatch(spliced)).toEqual([expect.objectContaining({ index: 1, code: "broken_link" })]);
  });

  it("flags indexes that are not consecutive", () => {
    const skipped = [chain[0], { ...chain[1], index: 2 }];
    expect(verifyJournalBatch(skipped).map((p) => p.code)).toContain("not_consecutive");
  });

  it("requires the entry at index 0 to have an empty prev", () => {
    const forged = { ...chain[0], prev: "a".repeat(64) };
    expect(verifyJournalBatch([forged]).map((p) => p.code)).toContain("bad_genesis");
  });

  it("refuses a hash that is not 64 lowercase hex characters", () => {
    expect(verifyJournalBatch([{ ...chain[0], hash: chain[0].hash.toUpperCase() }]).map((p) => p.code)).toContain(
      "bad_hash",
    );
    expect(verifyJournalBatch([{ ...chain[0], hash: "abc" }]).map((p) => p.code)).toContain("bad_hash");
  });

  it("refuses a line that is not a journal entry at all", () => {
    const raw = "{nope";
    const entry: RawJournalEntry = { index: 0, hash: sha256Hex(raw), prev: "", raw };
    expect(verifyJournalBatch([entry]).map((p) => p.code)).toEqual(["unreadable"]);
  });

  it("reports every problem, not only the first", () => {
    const tampered = chain.map((e) => ({ ...e }));
    tampered[0].raw += " ";
    tampered[1].raw += " ";
    expect(verifyJournalBatch(tampered).filter((p) => p.code === "bad_hash").map((p) => p.index)).toEqual([0, 1]);
  });
});

describe("verifyJournalChain", () => {
  const chain = buildChain([{ event: "started" }, accepted(), { event: "plan_approved", detail: { plan_id: PID } }]);

  it("confirms an intact chain and names its head", () => {
    expect(verifyJournalChain(chain)).toEqual({ ok: true, entries: 3, head: chain[2].hash });
  });

  it("treats an empty mirror as intact", () => {
    expect(verifyJournalChain([])).toEqual({ ok: true, entries: 0, head: "" });
  });

  it("names the first altered entry", () => {
    const tampered = chain.map((e) => ({ ...e }));
    tampered[1].raw = tampered[1].raw.replace("2026-10-05", "2026-10-06");
    expect(verifyJournalChain(tampered)).toMatchObject({ ok: false, atIndex: 1 });
  });

  it("notices a removed entry", () => {
    expect(verifyJournalChain([chain[0], chain[2]])).toMatchObject({ ok: false, atIndex: 2 });
  });

  it("requires the mirror to start at the journal's first entry", () => {
    expect(verifyJournalChain(chain.slice(1))).toMatchObject({ ok: false, atIndex: 1 });
  });
});

describe("planJournalIngest", () => {
  const chain = buildChain([
    { event: "started" },
    accepted(),
    { event: "plan_approved", detail: { plan_id: PID } },
    { event: "order_submitted", detail: { plan_id: PID, payload: buyPayload("VTI", "1899.81"), alpaca_status: "accepted" } },
    { event: "order_submitted", detail: { plan_id: PID, payload: buyPayload("BIL", "499.95"), alpaca_status: "accepted" } },
    done(PID, "done", filledOrders()),
  ]);
  const chainId = chain[0].hash;
  const overlapOf = (entries: RawJournalEntry[]) => new Map(entries.map((e) => [e.index, e.hash]));

  it("appends a whole new chain from its first entry", () => {
    expect(
      planJournalIngest({ chainId, storedHeadIndex: null, storedHeadHash: null, storedOverlap: new Map(), batch: chain }),
    ).toEqual({ type: "append", toInsert: chain, duplicates: 0, nextIndex: 6 });
  });

  it("asks for what it is missing when a new chain's batch does not start at the beginning", () => {
    expect(
      planJournalIngest({ chainId, storedHeadIndex: null, storedHeadHash: null, storedOverlap: new Map(), batch: chain.slice(3) }),
    ).toEqual({ type: "gap", nextIndex: 0 });
  });

  it("insists the first entry of a chain is the chain's own id", () => {
    expect(
      planJournalIngest({
        chainId: "b".repeat(64),
        storedHeadIndex: null,
        storedHeadHash: null,
        storedOverlap: new Map(),
        batch: chain,
      }),
    ).toEqual({ type: "invalid", detail: expect.stringContaining("chain") });
  });

  it("continues a chain it already holds", () => {
    expect(
      planJournalIngest({
        chainId,
        storedHeadIndex: 2,
        storedHeadHash: chain[2].hash,
        storedOverlap: new Map(),
        batch: chain.slice(3),
      }),
    ).toEqual({ type: "append", toInsert: chain.slice(3), duplicates: 0, nextIndex: 6 });
  });

  it("recognises a batch it has already stored in full", () => {
    expect(
      planJournalIngest({
        chainId,
        storedHeadIndex: 5,
        storedHeadHash: chain[5].hash,
        storedOverlap: overlapOf(chain),
        batch: chain,
      }),
    ).toEqual({ type: "duplicate", duplicates: 6, nextIndex: 6 });
  });

  it("stores only the part of an overlapping batch it does not have", () => {
    expect(
      planJournalIngest({
        chainId,
        storedHeadIndex: 3,
        storedHeadHash: chain[3].hash,
        storedOverlap: overlapOf(chain.slice(0, 4)),
        batch: chain.slice(2),
      }),
    ).toEqual({ type: "append", toInsert: chain.slice(4), duplicates: 2, nextIndex: 6 });
  });

  it("reports where it is when the batch starts beyond what it holds (a restored database)", () => {
    expect(
      planJournalIngest({
        chainId,
        storedHeadIndex: 2,
        storedHeadHash: chain[2].hash,
        storedOverlap: new Map(),
        batch: chain.slice(5),
      }),
    ).toEqual({ type: "gap", nextIndex: 3 });
  });

  it("refuses to hold two versions of one entry", () => {
    const stored = overlapOf(chain.slice(0, 4));
    stored.set(2, "c".repeat(64));
    expect(
      planJournalIngest({
        chainId,
        storedHeadIndex: 3,
        storedHeadHash: chain[3].hash,
        storedOverlap: stored,
        batch: chain.slice(2),
      }),
    ).toEqual({ type: "conflict", index: 2, detail: expect.any(String) });
  });

  it("refuses an entry that does not continue the stored head", () => {
    expect(
      planJournalIngest({
        chainId,
        storedHeadIndex: 2,
        storedHeadHash: "d".repeat(64),
        storedOverlap: new Map(),
        batch: chain.slice(3),
      }),
    ).toEqual({ type: "conflict", index: 3, detail: expect.any(String) });
  });
});

describe("deriveCorePlans", () => {
  const upTo = (specs: Spec[], count: number) => parseStoredEntries(buildChain(specs).slice(0, count));

  const initialBuild: Spec[] = [
    { event: "started" },
    accepted(),
    { event: "plan_approved", detail: { plan_id: PID, fund: true } },
    { event: "order_submitted", detail: { plan_id: PID, payload: buyPayload("VTI", "1899.81"), alpaca_status: "accepted" } },
    { event: "order_submitted", detail: { plan_id: PID, payload: buyPayload("BIL", "499.95"), alpaca_status: "accepted" } },
    done(PID, "done", filledOrders()),
  ];

  it("follows an initial build from proposal to done", () => {
    const stages = [2, 3, 4, 5].map((count) => deriveCorePlans(upTo(initialBuild, count))[0]);
    expect(stages.map((p) => p.status)).toEqual(["awaiting_approval", "approved", "buying", "buying"]);
    expect(findOpenPlan(deriveCorePlans(upTo(initialBuild, 2)))?.id).toBe(PID);

    const [plan] = deriveCorePlans(upTo(initialBuild, 6));
    expect(plan).toMatchObject({
      id: PID,
      kind: "initial",
      status: "done",
      executeOn: "2026-10-05",
      decidedOn: "2026-10-02",
      redecision: false,
      fundedByOwner: true,
    });
    expect(plan.buys).toEqual([
      { symbol: "BIL", notionalUsd: "499.95" },
      { symbol: "VTI", notionalUsd: "1899.81" },
    ]);
    expect(plan.closedAt).toEqual(new Date("2026-10-05T13:05:00.123Z"));
    // 18.5 x 102.69 + 5.4 x 91.00 = 1899.765 + 491.4 = 2391.165 dollars, truncated to the cent
    expect(plan.tradedUsdCents).toBe(239_116);
    // The journal sorts its keys (json.dumps(sort_keys=True)), so a closing entry's orders arrive by client id;
    // the page lists sells before buys, then by symbol, whichever way they arrive.
    expect(plan.orders.map((o) => [o.symbol, o.side, o.status, o.filledQty, o.filledAvgPrice, o.notionalUsd])).toEqual([
      ["BIL", "buy", "filled", "5.4", "91.00", "499.95"],
      ["VTI", "buy", "filled", "18.5", "102.69", "1899.81"],
    ]);
    expect(findOpenPlan(deriveCorePlans(upTo(initialBuild, 6)))).toBeNull();
  });

  it("moves a rebalance through selling and then buying", () => {
    const specs: Spec[] = [
      { event: "started" },
      accepted(PID, { kind: "rebalance", status: "approved" }),
      { event: "order_submitted", detail: { plan_id: PID, payload: sellPayload("VTI", "3.2"), alpaca_status: "accepted" } },
      { event: "order_submitted", detail: { plan_id: PID, payload: buyPayload("BND", "300.00"), alpaca_status: "accepted" } },
    ];
    expect(deriveCorePlans(upTo(specs, 2))[0].status).toBe("approved");
    expect(deriveCorePlans(upTo(specs, 3))[0].status).toBe("selling");
    expect(deriveCorePlans(upTo(specs, 4))[0].status).toBe("buying");
    expect(deriveCorePlans(upTo(specs, 3))[0].orders[0]).toMatchObject({ side: "sell", qty: "3.2", notionalUsd: null });
  });

  it("lists a closed rebalance's sells before its buys, whatever order the journal's sorted keys gave", () => {
    const orders = {
      // Sorted by client order id, as the journal writes them: the BND buy (B) comes before the VTI sell (V).
      [`core-${PID}-BND-b`]: { symbol: "BND", side: "buy", status: "filled", payload: buyPayload("BND", "300.00"), filled_qty: "3", filled_avg_price: "100.00" },
      [`core-${PID}-VTI-s`]: { symbol: "VTI", side: "sell", status: "filled", payload: sellPayload("VTI", "3.2"), filled_qty: "3.2", filled_avg_price: "100.00" },
    };
    const specs: Spec[] = [{ event: "started" }, accepted(PID, { kind: "rebalance", status: "approved" }), done(PID, "done", orders)];
    const [plan] = deriveCorePlans(upTo(specs, 3));
    expect(plan.orders.map((o) => [o.side, o.symbol])).toEqual([
      ["sell", "VTI"],
      ["buy", "BND"],
    ]);
    expect(plan.tradedUsdCents).toBe(62_000); // $620.00 traded in all: both legs count, a sale is traded dollars too
  });

  it("lets a plan nobody approved expire, having traded nothing", () => {
    const specs: Spec[] = [{ event: "started" }, accepted(), done(PID, "expired", {}, "its session passed before it could start")];
    const [plan] = deriveCorePlans(upTo(specs, 3));
    expect(plan).toMatchObject({
      status: "expired",
      outcome: "its session passed before it could start",
      tradedUsdCents: 0,
      orders: [],
    });
  });

  it("counts only what an abandoned plan actually filled", () => {
    const orders = {
      ...filledOrders(),
      [`core-${PID}-BIL-b`]: {
        symbol: "BIL",
        side: "buy",
        status: "canceled",
        payload: buyPayload("BIL", "499.95"),
        filled_qty: "0",
        filled_avg_price: "",
      },
    };
    const specs: Spec[] = [{ event: "started" }, accepted(), done(PID, "abandoned", orders, "still buying at 15:30 New York")];
    const [plan] = deriveCorePlans(upTo(specs, 3));
    expect(plan.status).toBe("abandoned");
    expect(plan.tradedUsdCents).toBe(189_976); // 18.5 x 102.69 = 1899.765 -> 1899.76 truncated
    expect(plan.orders.map((o) => [o.symbol, o.status])).toEqual([
      ["BIL", "canceled"],
      ["VTI", "filled"],
    ]);
  });

  it("closes a superseded plan when the next one is accepted", () => {
    const specs: Spec[] = [
      { event: "started" },
      accepted(PID),
      { event: "plan_superseded", detail: { plan_id: PID, by: PID_B } },
      accepted(PID_B, { kind: "rebalance" }),
    ];
    const plans = deriveCorePlans(upTo(specs, 4));
    expect(plans.map((p) => [p.id, p.status])).toEqual([
      [PID, "superseded"],
      [PID_B, "awaiting_approval"],
    ]);
    expect(findOpenPlan(plans)?.id).toBe(PID_B);
  });

  it("shows a proposal that broke a limit as one closed plan with its problems", () => {
    const specs: Spec[] = [
      { event: "started" },
      { event: "plan_rejected", detail: { plan_id: PID, problems: ["turnover 31% is over the 25% cap"], plan: INITIAL_PLAN } },
    ];
    const [plan] = deriveCorePlans(upTo(specs, 2));
    expect(plan).toMatchObject({ id: PID, status: "rejected", problems: ["turnover 31% is over the 25% cap"] });
    expect(plan.buys.length).toBe(2);
  });

  it("still shows a rejection that names no plan (an over-funded account)", () => {
    const specs: Spec[] = [
      { event: "started" },
      { event: "plan_rejected", detail: { problems: ["account cash $100000 exceeds the funded cap"] } },
    ];
    const plans = deriveCorePlans(upTo(specs, 2));
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ status: "rejected", problems: ["account cash $100000 exceeds the funded cap"] });
    expect(plans[0].id).toMatch(/^rejected-[0-9a-f]{8}$/);
  });

  it("shows an order Alpaca refused as rejected, with its reason", () => {
    const refused = {
      [`core-${PID}-VTI-b`]: {
        symbol: "VTI",
        side: "buy",
        status: "rejected",
        payload: buyPayload("VTI", "1899.81"),
        error: "insufficient buying power",
      },
    };
    const specs: Spec[] = [
      { event: "started" },
      accepted(),
      { event: "order_rejected", detail: { plan_id: PID, symbol: "VTI", side: "buy", error: "insufficient buying power" } },
      done(PID, "done", refused),
    ];
    expect(deriveCorePlans(upTo(specs, 3))[0].orders).toMatchObject([{ symbol: "VTI", status: "rejected", error: "insufficient buying power" }]);
    expect(deriveCorePlans(upTo(specs, 4))[0].orders).toMatchObject([{ symbol: "VTI", status: "rejected", error: "insufficient buying power" }]);
  });

  it("turns deadline cancellations and blocked buys into notes on the plan", () => {
    const specs: Spec[] = [
      { event: "started" },
      accepted(),
      { event: "sells_cancelled_at_deadline", detail: { plan_id: PID } },
      { event: "buy_blocked", detail: { plan_id: PID, code: "circuit_breaker", detail: "down 2.6% today" } },
      { event: "buys_cancelled_at_deadline", detail: { plan_id: PID } },
    ];
    const [plan] = deriveCorePlans(upTo(specs, 5));
    expect(plan.notes).toEqual([
      "Sells did not fill in time and were cancelled",
      "Buys blocked: circuit_breaker: down 2.6% today",
      "Buys did not fill in time and were cancelled",
    ]);
  });

  it("starts a fresh lifecycle when the same plan id is proposed again after it closed", () => {
    const specs: Spec[] = [
      { event: "started" },
      accepted(),
      done(PID, "expired", {}, "its session passed"),
      accepted(),
    ];
    const plans = deriveCorePlans(upTo(specs, 4));
    expect(plans.map((p) => p.status)).toEqual(["expired", "awaiting_approval"]);
  });

  it("ignores events about a plan it never saw, and malformed bodies, without throwing", () => {
    const specs: Spec[] = [
      { event: "started" },
      { event: "plan_approved", detail: { plan_id: "ffffffffffffffff" } },
      { event: "order_submitted", detail: { plan_id: PID, payload: "not an object" } },
      { event: "plan_accepted", detail: { plan_id: PID, plan: 7, status: 12 } },
      { event: "plan_done", detail: { plan_id: PID, orders: [1, 2] } },
    ];
    expect(() => deriveCorePlans(upTo(specs, 5))).not.toThrow();
    const plans = deriveCorePlans(upTo(specs, 5));
    expect(plans.find((p) => p.id === PID)?.status).toBe("done");
  });

  it("returns nothing for a journal with no plans", () => {
    expect(deriveCorePlans(upTo([{ event: "started" }, { event: "no_plan", detail: { session: "2026-10-02" } }], 2))).toEqual([]);
  });
});

describe("parseStoredEntries", () => {
  it("keeps a line it cannot read visible instead of dropping it", () => {
    const [good] = buildChain([{ event: "started" }]);
    const bad: RawJournalEntry = { index: 1, hash: sha256Hex("{nope"), prev: good.hash, raw: "{nope" };
    const parsed = parseStoredEntries([good, bad]);
    expect(parsed.map((e) => e.event)).toEqual(["started", "unreadable"]);
    expect(parsed[1].index).toBe(1);
  });
});

describe("describeCoreEvent", () => {
  const describeOf = (spec: Spec) => describeCoreEvent(parseStoredEntries(buildChain([spec]))[0]);

  it.each([
    [{ event: "started" }, /router started/i, "neutral"],
    [accepted(), /proposed/i, "warning"],
    [accepted(PID, { status: "approved" }), /proposed/i, "neutral"],
    [{ event: "plan_approved", detail: { plan_id: PID, fund: true } }, /approved/i, "positive"],
    [{ event: "order_submitted", detail: { plan_id: PID, payload: buyPayload("VTI", "1899.81"), alpaca_status: "accepted" } }, /buy VTI/i, "neutral"],
    [{ event: "order_rejected", detail: { plan_id: PID, symbol: "VTI", side: "buy", error: "nope" } }, /refused/i, "critical"],
    [done(PID, "done", filledOrders()), /done/i, "positive"],
    [done(PID, "abandoned", {}, "died"), /abandoned/i, "warning"],
    [done(PID, "expired", {}, "late"), /expired/i, "warning"],
    [done(PID, "deferred", {}, "breaker"), /deferred/i, "warning"],
    [done(PID, "halted", {}, "kill switch"), /halted/i, "critical"],
    [{ event: "plan_mismatch", detail: { session: "2026-10-02" } }, /disagreed/i, "critical"],
    [{ event: "plan_rejected", detail: { plan_id: PID, problems: ["x"] } }, /limit/i, "critical"],
    [{ event: "no_plan", detail: { session: "2026-10-02", reason: "not a rebalance day" } }, /no plan/i, "neutral"],
    [{ event: "tick_failed", detail: { error: "boom", consecutive: 3 } }, /failing/i, "critical"],
    [{ event: "journal_invalid" }, /integrity/i, "critical"],
  ])("labels %j", (spec, label, tone) => {
    const described = describeOf(spec as Spec);
    expect(described.label).toMatch(label);
    expect(described.tone).toBe(tone);
  });

  it("shows an order's amount in dollars with grouping, and a sale's in shares", () => {
    expect(describeOf({ event: "order_submitted", detail: { plan_id: PID, payload: buyPayload("VTI", "1899.81"), alpaca_status: "accepted" } }).detail).toBe("$1,899.81 · accepted");
    expect(describeOf({ event: "order_submitted", detail: { plan_id: PID, payload: sellPayload("VTI", "3.200000000"), alpaca_status: "accepted" } }).detail).toBe("3.2 sh · accepted");
  });

  it("says which orders did not fill when a plan finishes with some unfilled", () => {
    const orders = { ...filledOrders(), [`core-${PID}-BIL-b`]: { symbol: "BIL", side: "buy", status: "canceled", payload: buyPayload("BIL", "499.95") } };
    const described = describeOf(done(PID, "done", orders));
    expect(described.tone).toBe("warning");
    expect(described.detail).toMatch(/1 of 2 orders did not fill/);
  });

  it("falls back to the event's own name for one it does not know", () => {
    expect(describeOf({ event: "something_new" })).toMatchObject({ label: "Something new", tone: "neutral" });
  });

  it("passes text through untouched and bounded: markup is the renderer's problem, never mangled or unbounded here", () => {
    const hostile = `<img src=x onerror="alert(1)">${"x".repeat(500)}`;
    const described = describeOf({ event: "tick_failed", detail: { error: hostile, consecutive: 3 } });
    expect(described.detail).toContain('<img src=x onerror="alert(1)">');
    expect((described.detail ?? "").length).toBeLessThanOrEqual(240);
  });
});

describe("computeCoreAllocation", () => {
  const targets = { BIL: "0.05", BND: "0.19", IAU: "0.19", VNQ: "0.19", VTI: "0.19", VXUS: "0.19" };
  const position = (symbol: string, marketValueUsdCents: number | null, qty = "1") => ({
    symbol,
    qty,
    marketValueUsdCents,
    avgEntryPriceUsdCents: null,
    currentPriceUsdCents: null,
  });

  it("compares each holding's share of the account with its target", () => {
    const view = computeCoreAllocation({
      equityUsdCents: 1_000_000,
      cashUsdCents: 100,
      positions: [
        position("VTI", 200_000),
        position("VXUS", 190_000),
        position("BND", 190_000),
        position("IAU", 190_000),
        position("VNQ", 180_000),
        position("BIL", 49_900),
      ],
      targets,
    });
    const byTicker = Object.fromEntries(view.rows.map((r) => [r.symbol, r]));
    expect(byTicker.VTI).toMatchObject({ targetBps: 1900, actualBps: 2000, driftBps: 100, marketValueUsdCents: 200_000 });
    expect(byTicker.VNQ).toMatchObject({ actualBps: 1800, driftBps: -100 });
    expect(byTicker.BIL).toMatchObject({ targetBps: 500, actualBps: 499, driftBps: -1 });
    expect(view.cashBps).toBe(1); // $1.00 of $10,000.00
    expect(view.investedUsdCents).toBe(999_900);
  });

  it("lists a target it holds none of, as zero", () => {
    const view = computeCoreAllocation({ equityUsdCents: 1_000_000, cashUsdCents: 1_000_000, positions: [], targets });
    expect(view.rows.find((r) => r.symbol === "VTI")).toMatchObject({ targetBps: 1900, actualBps: 0, driftBps: -1900, marketValueUsdCents: 0 });
    expect(view.cashBps).toBe(10_000);
  });

  it("lists a holding that has no target, with no drift to speak of", () => {
    const view = computeCoreAllocation({
      equityUsdCents: 1_000_000,
      cashUsdCents: 0,
      positions: [position("TSLA", 100_000)],
      targets,
    });
    expect(view.rows.find((r) => r.symbol === "TSLA")).toMatchObject({ targetBps: null, actualBps: 1000, driftBps: null });
  });

  it("does not guess a share when the broker gave no market value", () => {
    const view = computeCoreAllocation({
      equityUsdCents: 1_000_000,
      cashUsdCents: 0,
      positions: [position("VTI", null, "12.5")],
      targets,
    });
    expect(view.rows.find((r) => r.symbol === "VTI")).toMatchObject({ actualBps: null, driftBps: null, marketValueUsdCents: null, qty: "12.5" });
  });

  it("has no shares to report for an account worth nothing", () => {
    const view = computeCoreAllocation({ equityUsdCents: 0, cashUsdCents: 0, positions: [position("VTI", 0)], targets });
    expect(view.rows.every((r) => r.actualBps === null)).toBe(true);
    expect(view.cashBps).toBeNull();
  });

  it("orders targets first, largest to smallest then by symbol, and untargeted holdings last", () => {
    const view = computeCoreAllocation({
      equityUsdCents: 1_000_000,
      cashUsdCents: 0,
      positions: [position("ZZZ", 1), position("AAA", 1)],
      targets,
    });
    expect(view.rows.map((r) => r.symbol)).toEqual(["BND", "IAU", "VNQ", "VTI", "VXUS", "BIL", "AAA", "ZZZ"]);
  });

  it("rounds a share to the nearest basis point, half up", () => {
    const view = computeCoreAllocation({
      equityUsdCents: 20_000,
      cashUsdCents: 0,
      positions: [position("VTI", 3_799)], // 18.995%
      targets,
    });
    expect(view.rows.find((r) => r.symbol === "VTI")?.actualBps).toBe(1900);
  });
});

describe("shareInBps", () => {
  it("is a share of a whole in basis points, rounded half away from zero", () => {
    expect(shareInBps(190_000, 1_000_000)).toBe(1900);
    expect(shareInBps(49_900, 1_000_000)).toBe(499);
    expect(shareInBps(3_799, 20_000)).toBe(1900); // 1899.5 bp
    expect(shareInBps(1, 20_000)).toBe(1); // 0.5 bp
  });

  it("rounds a loss the same way as a gain of the same size", () => {
    expect(shareInBps(-1, 20_000)).toBe(-1);
    expect(shareInBps(-3_799, 20_000)).toBe(-1900);
    expect(shareInBps(-190_000, 1_000_000)).toBe(-1900);
  });

  it("is zero for nothing and has no answer without a whole", () => {
    expect(shareInBps(0, 1_000_000)).toBe(0);
    expect(shareInBps(5, 0)).toBeNull();
    expect(shareInBps(5, -10)).toBeNull();
  });
});

describe("routerFreshness", () => {
  const now = new Date("2026-10-05T12:00:00Z");
  const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);

  it("has never heard from a router that has not reported", () => {
    expect(routerFreshness(null, now)).toEqual({ state: "never", ageSeconds: null });
  });

  it("calls a report from the last quarter hour fresh", () => {
    expect(routerFreshness(ago(60), now)).toEqual({ state: "fresh", ageSeconds: 60 });
    expect(routerFreshness(ago(15 * 60), now).state).toBe("fresh");
  });

  it("calls a report from earlier today stale, not alarming: the router may simply be off outside its window", () => {
    expect(routerFreshness(ago(15 * 60 + 1), now).state).toBe("stale");
    expect(routerFreshness(ago(24 * 3600), now).state).toBe("stale");
  });

  it("calls anything older silent", () => {
    expect(routerFreshness(ago(24 * 3600 + 1), now).state).toBe("silent");
  });

  it("treats a report from the future (clock skew) as fresh, never negative", () => {
    expect(routerFreshness(new Date(now.getTime() + 5000), now)).toEqual({ state: "fresh", ageSeconds: 0 });
  });
});
