import { sha256Hex, type RawJournalEntry } from "../../src/lib/core-journal";
import type { createAdminClient } from "../../src/server/db/admin-client";
import type { SeededRng } from "./rng";

/**
 * A believable mirror of the long-term core for the demo account
 * (AGENTS.md §3fff), so the page is populated on a freshly seeded
 * database, under Demo Login, and in the accessibility audit — without a
 * router running. The story: the owner funded a $10,000 paper account
 * five weeks ago, approved the initial build, it filled the next morning
 * across six ETFs, and the router has been idling since ("not a rebalance
 * day") while prices drift.
 *
 * Everything here is invented, like the rest of the demo ledger. The
 * journal is a REAL hash chain built the way the router builds one (sorted
 * keys, `", "`/`": "` separators, each `prev` the sha256 of the previous
 * line), so the page's own integrity check passes on it rather than the
 * seed bypassing it. Figures are integer USD cents; share quantities are
 * nine-decimal strings, as Alpaca's are.
 *
 * Pure (`buildCoreMirrorSeed`) and written separately (`seedCoreMirror`),
 * so the story can be tested without a database.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const FUNDED_CENTS = 1_000_000;
const RESERVE_CENTS = 100;

const POLICY = {
  mix: { BIL: 500, BND: 1900, IAU: 1900, VNQ: 1900, VTI: 1900, VXUS: 1900 } as Record<string, number>,
  /** Indicative prices in cents; the seed nudges each by up to 1%. */
  startPrices: { BIL: 9_150, BND: 7_300, IAU: 6_300, VNQ: 9_100, VTI: 29_000, VXUS: 6_500 } as Record<string, number>,
};

const WEIGHT_STRING: Record<string, string> = { BIL: "0.05", BND: "0.19", IAU: "0.19", VNQ: "0.19", VTI: "0.19", VXUS: "0.19" };

/** Python's `json.dumps(value, sort_keys=True)`. */
function pyJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pyJson).join(", ")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}: ${pyJson(record[key])}`)
    .join(", ")}}`;
}

/** Python's `datetime.isoformat()` for a UTC instant: microseconds and `+00:00`. */
function pyIso(date: Date): string {
  return `${date.toISOString().slice(0, -1)}000+00:00`;
}

function dollars(cents: number): string {
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** A nine-decimal share quantity for `notionalCents` at `priceCents`, truncated, in exact integer arithmetic. */
function quantity(notionalCents: number, priceCents: number): string {
  const nano = (BigInt(notionalCents) * 1_000_000_000n) / BigInt(priceCents);
  const digits = nano.toString().padStart(10, "0");
  return `${digits.slice(0, -9)}.${digits.slice(-9)}`;
}

function marketValueCents(qty: string, priceCents: number): number {
  const [whole, fraction] = qty.split(".");
  const nano = BigInt(whole) * 1_000_000_000n + BigInt(fraction);
  return Number((nano * BigInt(priceCents) + 500_000_000n) / 1_000_000_000n);
}

export type SeededCoreSnapshot = {
  takenAt: Date;
  equityUsdCents: number;
  cashUsdCents: number;
  lastEquityUsdCents: number;
  positions: {
    symbol: string;
    qty: string;
    marketValueUsdCents: number;
    avgEntryPriceUsdCents: number;
    currentPriceUsdCents: number;
  }[];
  targets: Record<string, string>;
};

export type CoreMirrorSeed = {
  chainId: string;
  entries: RawJournalEntry[];
  planId: string;
  snapshots: SeededCoreSnapshot[];
  reportedAt: Date;
  effectiveFrom: string;
  policySha256: string;
};

export function buildCoreMirrorSeed(now: Date, rng: SeededRng): CoreMirrorSeed {
  const policySha256 = sha256Hex("seeded demo policy for the long-term core");
  const buildDay = new Date(Math.floor((now.getTime() - 38 * DAY_MS) / DAY_MS) * DAY_MS);
  const at = (day: Date, hour: number, minute: number) => new Date(day.getTime() + (hour * 60 + minute) * 60_000);
  const dateOf = (date: Date) => date.toISOString().slice(0, 10);
  const executeDay = new Date(buildDay.getTime() + DAY_MS);
  const planId = sha256Hex(`seeded-core-plan-${dateOf(buildDay)}`).slice(0, 16);

  // --- the build: what was bought, at what price -------------------------------------------------------
  const prices: Record<string, number> = {};
  for (const [symbol, base] of Object.entries(POLICY.startPrices)) {
    prices[symbol] = Math.round(base * (1 + (rng.float() - 0.5) * 0.02));
  }
  const spendable = FUNDED_CENTS - RESERVE_CENTS;
  const symbols = Object.keys(POLICY.mix).sort();
  const notional: Record<string, number> = {};
  const qty: Record<string, string> = {};
  for (const symbol of symbols) {
    notional[symbol] = Math.floor((spendable * POLICY.mix[symbol]) / 10_000);
    qty[symbol] = quantity(notional[symbol], prices[symbol]);
  }
  const entryPrice = { ...prices };

  const payload = (symbol: string) => ({
    symbol,
    side: "buy",
    type: "limit",
    time_in_force: "day",
    notional: dollars(notional[symbol]),
    limit_price: dollars(Math.ceil(entryPrice[symbol] * 1.03)),
    client_order_id: `core-${planId}-${symbol}-b`,
    extended_hours: false,
  });

  const specs: { at: Date; event: string; detail?: Record<string, unknown> }[] = [
    { at: at(buildDay, 20, 0), event: "started", detail: { account: "PA0DEMO00001" } },
    {
      at: at(buildDay, 21, 30),
      event: "plan_accepted",
      detail: {
        plan_id: planId,
        kind: "initial",
        status: "awaiting_approval",
        execute_on: dateOf(executeDay),
        redecision: false,
        plan: {
          decided_on: dateOf(buildDay),
          reason: "initial",
          targets: WEIGHT_STRING,
          sells: {},
          buys: Object.fromEntries(symbols.map((s) => [s, dollars(notional[s])])),
        },
      },
    },
    { at: at(buildDay, 22, 5), event: "plan_approved", detail: { plan_id: planId, fund: true } },
    ...symbols.map((symbol, i) => ({
      at: at(executeDay, 13, 22 + Math.floor(i / 3)),
      event: "order_submitted",
      detail: { plan_id: planId, payload: payload(symbol), alpaca_status: "accepted" },
    })),
    {
      at: at(executeDay, 13, 50),
      event: "plan_done",
      detail: {
        plan_id: planId,
        kind: "initial",
        reason: null,
        orders: Object.fromEntries(
          symbols.map((symbol) => [
            `core-${planId}-${symbol}-b`,
            {
              symbol,
              side: "buy",
              status: "filled",
              payload: payload(symbol),
              filled_qty: qty[symbol],
              filled_avg_price: dollars(entryPrice[symbol]),
            },
          ]),
        ),
      },
    },
  ];

  // Quiet weeks afterwards: the Allocator proposes nothing between quarter-ends.
  const noPlanEvery = 6;
  for (let day = 4; buildDay.getTime() + day * DAY_MS < now.getTime() - DAY_MS; day += noPlanEvery) {
    const session = new Date(buildDay.getTime() + day * DAY_MS);
    specs.push({
      at: at(session, 21, 31),
      event: "no_plan",
      detail: { session: dateOf(session), reason: "not a rebalance day" },
    });
  }

  const entries: RawJournalEntry[] = [];
  let prev = "";
  specs.forEach((spec, index) => {
    const raw = pyJson({ at: pyIso(spec.at), event: spec.event, policy_sha256: policySha256, prev, ...spec.detail });
    const hash = sha256Hex(raw);
    entries.push({ index, hash, prev, raw });
    prev = hash;
  });

  // --- the account day by day since the build -------------------------------------------------------------
  const cashCents = FUNDED_CENTS - symbols.reduce((sum, s) => sum + notional[s], 0);
  const snapshots: SeededCoreSnapshot[] = [];
  const current = { ...prices };
  let lastEquity = FUNDED_CENTS;
  const days = Math.floor((now.getTime() - executeDay.getTime()) / DAY_MS);
  for (let d = 0; d <= days; d++) {
    const takenAt = d === days ? new Date(now.getTime() - 2 * 60_000) : at(new Date(executeDay.getTime() + d * DAY_MS), 21, 5);
    if (d > 0) {
      for (const symbol of symbols) {
        // BIL (T-bills) barely moves; the rest wander up to 0.8% a day.
        const swing = symbol === "BIL" ? 0.0004 : 0.016;
        current[symbol] = Math.max(100, Math.round(current[symbol] * (1 + (rng.float() - 0.5) * swing)));
      }
    }
    const positions = symbols.map((symbol) => ({
      symbol,
      qty: qty[symbol],
      marketValueUsdCents: marketValueCents(qty[symbol], current[symbol]),
      avgEntryPriceUsdCents: entryPrice[symbol],
      currentPriceUsdCents: current[symbol],
    }));
    const equity = cashCents + positions.reduce((sum, p) => sum + p.marketValueUsdCents, 0);
    snapshots.push({
      takenAt,
      equityUsdCents: equity,
      cashUsdCents: cashCents,
      lastEquityUsdCents: lastEquity,
      positions,
      targets: WEIGHT_STRING,
    });
    lastEquity = equity;
  }

  return {
    chainId: entries[0].hash,
    entries,
    planId,
    snapshots,
    reportedAt: new Date(now.getTime() - 2 * 60_000),
    effectiveFrom: dateOf(executeDay),
    policySha256,
  };
}

/** Writes the demo mirror for `userId`. The seed's reset has already removed any earlier one (the tables cascade from `User`). */
export async function seedCoreMirror(
  prisma: ReturnType<typeof createAdminClient>,
  userId: string,
  now: Date,
  rng: SeededRng,
): Promise<{ entries: number; snapshots: number }> {
  const seed = buildCoreMirrorSeed(now, rng);

  await prisma.coreJournalEntry.createMany({
    data: seed.entries.map((entry) => {
      const parsed = JSON.parse(entry.raw) as { at: string; event: string; plan_id?: string };
      return {
        userId,
        chainId: seed.chainId,
        entryIndex: entry.index,
        entryHash: entry.hash,
        prevHash: entry.prev,
        event: parsed.event,
        planId: parsed.plan_id ?? null,
        occurredAt: new Date(parsed.at),
        rawLine: entry.raw,
      };
    }),
  });

  await prisma.coreSnapshot.createMany({
    data: seed.snapshots.map((snapshot) => ({
      userId,
      takenAt: snapshot.takenAt,
      equityUsdCents: BigInt(snapshot.equityUsdCents),
      cashUsdCents: BigInt(snapshot.cashUsdCents),
      lastEquityUsdCents: BigInt(snapshot.lastEquityUsdCents),
      positions: snapshot.positions,
      targets: snapshot.targets,
    })),
  });

  await prisma.coreRouterStatus.create({
    data: {
      userId,
      reportedAt: seed.reportedAt,
      tradingEnabled: true,
      halted: false,
      policySha256: seed.policySha256,
      policyEffectiveFrom: seed.effectiveFrom,
      journalOk: true,
      journalEntries: seed.entries.length,
      tickAgeSeconds: 6,
      tickFailures: 0,
      attention: [],
    },
  });

  return { entries: seed.entries.length, snapshots: seed.snapshots.length };
}
