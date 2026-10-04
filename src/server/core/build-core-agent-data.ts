import "server-only";
import { cache } from "react";
import {
  computeCoreAllocation,
  deriveCorePlans,
  describeCoreEvent,
  findOpenPlan,
  parseStoredEntries,
  routerFreshness,
  shareInBps,
  verifyJournalChain,
  type ChainVerdict,
  type CorePlan,
  type EventTone,
} from "../../lib/core-journal";
import { convertNativeAmountToAgorot } from "../../lib/exchange-rate";
import { nativeAmount } from "../../lib/currency";
import { getCoreMirror, type CoreStatusView } from "../dal/core-mirror";
import { getLatestRateTable } from "../dal/exchange-rates";

/**
 * Everything `/trading/core` shows, assembled once per request (AGENTS.md
 * §3fff). `cache()`-wrapped like every other `build-*-data.ts` aggregator
 * (§3c) — request-scoped only, never Next's cross-request `'use cache'`:
 * this is one user's trading record, and a cache scoped even slightly
 * wrong would serve it to someone else. Primitive argument, no varying
 * inputs besides it, and the clock is read inside so every call in one
 * request shares one answer.
 *
 * The core's account is a US-dollar Alpaca paper account, so every figure
 * here is USD cents natively and is converted to shekels HERE, at read
 * time, at the latest synced rate — never stored (law #3: a live balance
 * converts at the live rate, the same split a foreign-currency
 * `BankAccount` makes). Nothing on this page reaches net worth or any
 * other aggregate: the core is a separate paper account, mirrored for
 * viewing only.
 */

export type CoreMoney = { usdCents: number; ilsAgorot: number };

export type CoreAllocationViewRow = {
  symbol: string;
  qty: string;
  market: CoreMoney | null;
  targetBps: number | null;
  actualBps: number | null;
  driftBps: number | null;
};

export type CoreAccountView = {
  takenAt: Date;
  ageSeconds: number;
  equity: CoreMoney;
  cash: CoreMoney;
  invested: CoreMoney;
  dayChange: (CoreMoney & { bps: number | null }) | null;
  usdIlsRate: number;
  rows: CoreAllocationViewRow[];
  cashBps: number | null;
};

export type CoreEventView = {
  index: number;
  hash: string;
  at: Date;
  planId: string | null;
  label: string;
  detail: string | null;
  tone: EventTone;
};

export type CoreAgentData =
  /** The mirror's tables do not exist on this deployment yet (the migration has not been applied). */
  | { state: "unavailable" }
  /** The tables exist and nothing has been synced: the router has never reported. */
  | { state: "empty" }
  | {
      state: "ready";
      now: Date;
      freshness: ReturnType<typeof routerFreshness>;
      status: CoreStatusView | null;
      /** Whether the stored mirror is a whole, unaltered chain — recomputed from the stored lines on every read. */
      integrity: ChainVerdict;
      mirroredEntries: number;
      chainCount: number;
      /** Oldest first. */
      plans: CorePlan[];
      openPlan: CorePlan | null;
      /** Newest first, at most `MAX_EVENTS_SHOWN`. */
      events: CoreEventView[];
      hiddenEventCount: number;
      account: CoreAccountView | null;
    };

export const MAX_EVENTS_SHOWN = 40;

function toMoney(usdCents: number, usdIlsRate: number): CoreMoney {
  return { usdCents, ilsAgorot: convertNativeAmountToAgorot(nativeAmount(usdCents), "USD", usdIlsRate) };
}

export const buildCoreAgentData = cache(async (userId: string): Promise<CoreAgentData> => {
  const now = new Date();
  const mirror = await getCoreMirror(userId);
  if (!mirror.available) return { state: "unavailable" };
  if (!mirror.status && !mirror.snapshot && mirror.entries.length === 0) return { state: "empty" };

  const integrity = verifyJournalChain(mirror.entries);
  const parsed = parseStoredEntries(mirror.entries);
  const plans = deriveCorePlans(parsed);

  const newestFirst = [...parsed].reverse();
  const events: CoreEventView[] = newestFirst.slice(0, MAX_EVENTS_SHOWN).map((entry) => ({
    index: entry.index,
    hash: entry.hash,
    at: entry.at,
    planId: entry.planId,
    ...describeCoreEvent(entry),
  }));

  let account: CoreAccountView | null = null;
  if (mirror.snapshot) {
    const snapshot = mirror.snapshot;
    const usdIlsRate = (await getLatestRateTable(now)).USD;
    const allocation = computeCoreAllocation({
      equityUsdCents: snapshot.equityUsdCents,
      cashUsdCents: snapshot.cashUsdCents,
      positions: snapshot.positions,
      targets: snapshot.targets,
    });
    const change = snapshot.lastEquityUsdCents === null ? null : snapshot.equityUsdCents - snapshot.lastEquityUsdCents;
    account = {
      takenAt: snapshot.takenAt,
      ageSeconds: Math.max(0, Math.round((now.getTime() - snapshot.takenAt.getTime()) / 1000)),
      equity: toMoney(snapshot.equityUsdCents, usdIlsRate),
      cash: toMoney(snapshot.cashUsdCents, usdIlsRate),
      invested: toMoney(allocation.investedUsdCents, usdIlsRate),
      dayChange:
        change === null || snapshot.lastEquityUsdCents === null
          ? null
          : { ...toMoney(change, usdIlsRate), bps: shareInBps(change, snapshot.lastEquityUsdCents) },
      usdIlsRate,
      cashBps: allocation.cashBps,
      rows: allocation.rows.map((row) => ({
        symbol: row.symbol,
        qty: row.qty,
        market: row.marketValueUsdCents === null ? null : toMoney(row.marketValueUsdCents, usdIlsRate),
        targetBps: row.targetBps,
        actualBps: row.actualBps,
        driftBps: row.driftBps,
      })),
    };
  }

  return {
    state: "ready",
    now,
    freshness: routerFreshness(mirror.status?.reportedAt ?? null, now),
    status: mirror.status,
    integrity,
    mirroredEntries: mirror.entries.length,
    chainCount: mirror.chainCount,
    plans,
    openPlan: findOpenPlan(plans),
    events,
    hiddenEventCount: Math.max(0, parsed.length - events.length),
    account,
  };
});
