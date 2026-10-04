import "server-only";
import { z } from "zod";
import {
  parseJournalLine,
  planJournalIngest,
  verifyJournalBatch,
  type CorePositionInput,
  type RawJournalEntry,
} from "../../lib/core-journal";
import { withUserScope } from "../db/with-user-scope";
import type { ReportPayload } from "../paper-trader/core-sync-schema";

/**
 * The DAL module for the long-term core's mirror (AGENTS.md §3fff): the
 * router's journal, its latest account snapshot and its latest
 * self-report, held read-only for the paper-trading account's owner.
 *
 * Every function is user-scoped through `withUserScope`, so Postgres RLS
 * backs the `where: { userId }` on every query. The journal table is
 * insert-only for this app's role at the database level (see the
 * migration's REVOKE): there is no function here that updates or deletes
 * a mirrored entry, and the database would refuse one if there were.
 *
 * **Degrades when the migration has not been applied.** This app deploys
 * on every push, but a migration is applied by a separate, gated
 * workflow, so for some window the code that reads these tables can be
 * live before the tables exist (AGENTS.md §3eee is the incident that
 * taught this, and §3xx the pattern). A missing table is therefore
 * reported as `{ available: false }` on the read path — the page renders
 * "not set up yet" instead of an error screen — and as
 * `CoreMirrorUnavailableError` on the write path, which the webhook turns
 * into a retryable 503 so the router simply keeps its cursor and tries
 * again after the migration. Only a missing table or column is treated
 * this way; any other failure is a real one and propagates.
 */

export class CoreMirrorUnavailableError extends Error {
  constructor(cause: unknown) {
    super("The core mirror tables are not available (has the migration been applied?)", { cause });
    this.name = "CoreMirrorUnavailableError";
  }
}

/** Prisma's "table does not exist" (P2021) and "column does not exist" (P2022). */
export function isMissingSchemaError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const { code } = error as { code: unknown };
  return code === "P2021" || code === "P2022";
}

let lastUnavailableLoggedAt = 0;
function logUnavailable(where: string, error: unknown): void {
  const now = Date.now();
  if (now - lastUnavailableLoggedAt > 60_000) {
    lastUnavailableLoggedAt = now;
    console.error(`${where}: the core mirror tables are missing — apply the core_agent_mirror migration`, error);
  }
}

// --- ingest ----------------------------------------------------------------------------------------------

export type IngestResult =
  | { status: "recorded" | "duplicate"; accepted: number; duplicates: number; nextIndex: number }
  | { status: "gap"; nextIndex: number }
  | { status: "conflict"; index: number; detail: string }
  | { status: "invalid"; detail: string };

/**
 * Verifies a batch of journal entries and appends what the mirror does not
 * already hold. The order is the point: integrity first (every hash is the
 * sha256 of its own line, the batch links to itself), then continuity
 * against what is stored (`planJournalIngest`), and only then a write.
 *
 * Idempotent and race-safe: the write is `INSERT … ON CONFLICT DO
 * NOTHING` on `(userId, chainId, entryIndex)`, so two copies of one batch
 * arriving together — a retry that overlapped its original — leave one
 * set of rows and two successful responses.
 */
export async function ingestCoreJournal(
  userId: string,
  batch: { chainId: string; entries: readonly RawJournalEntry[] },
): Promise<IngestResult> {
  const { chainId, entries } = batch;
  try {
    return await withUserScope(userId, async (tx) => {
      const problems = verifyJournalBatch(entries);
      if (problems.length > 0) {
        return { status: "invalid", detail: `entry ${problems[0].index}: ${problems[0].detail}` } as const;
      }

      const head = await tx.coreJournalEntry.findFirst({
        where: { userId, chainId },
        orderBy: { entryIndex: "desc" },
        select: { entryIndex: true, entryHash: true },
      });
      const first = entries[0].index;
      const last = entries[entries.length - 1].index;
      const overlap = head
        ? await tx.coreJournalEntry.findMany({
            where: { userId, chainId, entryIndex: { gte: first, lte: Math.min(last, head.entryIndex) } },
            select: { entryIndex: true, entryHash: true },
          })
        : [];

      const plan = planJournalIngest({
        chainId,
        storedHeadIndex: head?.entryIndex ?? null,
        storedHeadHash: head?.entryHash ?? null,
        storedOverlap: new Map(overlap.map((row) => [row.entryIndex, row.entryHash])),
        batch: entries,
      });

      switch (plan.type) {
        case "gap":
          return { status: "gap", nextIndex: plan.nextIndex } as const;
        case "conflict":
          return { status: "conflict", index: plan.index, detail: plan.detail } as const;
        case "invalid":
          return { status: "invalid", detail: plan.detail } as const;
        case "duplicate":
          return { status: "duplicate", accepted: 0, duplicates: plan.duplicates, nextIndex: plan.nextIndex } as const;
        case "append": {
          const written = await tx.coreJournalEntry.createMany({
            data: plan.toInsert.map((entry) => {
              // `verifyJournalBatch` already proved every line parses.
              const parsed = parseJournalLine(entry.raw);
              if (!parsed.ok) throw new Error("unreachable: a verified journal line failed to parse");
              return {
                userId,
                chainId,
                entryIndex: entry.index,
                entryHash: entry.hash,
                prevHash: entry.prev,
                event: parsed.event,
                planId: parsed.planId,
                occurredAt: parsed.at,
                rawLine: entry.raw,
              };
            }),
            skipDuplicates: true,
          });
          return {
            status: written.count > 0 ? "recorded" : "duplicate",
            accepted: written.count,
            duplicates: plan.duplicates + (plan.toInsert.length - written.count),
            nextIndex: plan.nextIndex,
          } as const;
        }
      }
    });
  } catch (error) {
    if (isMissingSchemaError(error)) {
      logUnavailable("ingestCoreJournal", error);
      throw new CoreMirrorUnavailableError(error);
    }
    throw error;
  }
}

// --- reports ---------------------------------------------------------------------------------------------

/**
 * Stores the router's latest self-report and, when it carries one, the
 * account snapshot. The status is one row per user, replaced by a report
 * at least as new as the stored one and ignored otherwise — a delayed
 * retry must never overwrite a newer state with an older one. A snapshot
 * is a fact about a moment, so it is added once per `takenAt` and never
 * changed.
 */
export async function recordCoreReport(
  userId: string,
  report: ReportPayload,
): Promise<{ status: "recorded" | "stale"; snapshotStored: boolean }> {
  const reportedAt = new Date(report.reported_at);
  const status = report.status;
  const data = {
    reportedAt,
    tradingEnabled: status.trading_enabled,
    disabledReason: status.disabled_reason,
    halted: status.halted,
    haltReason: status.halt_reason,
    policySha256: status.policy_sha256,
    policyEffectiveFrom: status.policy_effective_from,
    planId: status.plan?.id ?? null,
    planKind: status.plan?.kind ?? null,
    planStatus: status.plan?.status ?? null,
    planExecuteOn: status.plan?.execute_on ?? null,
    journalOk: status.journal.ok,
    journalEntries: status.journal.entries,
    journalReason: status.journal.reason,
    tickAgeSeconds: status.tick_age_seconds,
    tickFailures: status.tick_failures,
    attention: status.attention,
  };

  try {
    return await withUserScope(userId, async (tx) => {
      const existing = await tx.coreRouterStatus.findUnique({ where: { userId }, select: { reportedAt: true } });
      const fresh = !existing || existing.reportedAt.getTime() <= reportedAt.getTime();
      if (fresh) {
        await tx.coreRouterStatus.upsert({ where: { userId }, create: { userId, ...data }, update: data });
      }

      let snapshotStored = false;
      if (report.account) {
        const account = report.account;
        const written = await tx.coreSnapshot.createMany({
          data: [
            {
              userId,
              takenAt: new Date(account.taken_at),
              equityUsdCents: BigInt(account.equity_usd_cents),
              cashUsdCents: BigInt(account.cash_usd_cents),
              lastEquityUsdCents: account.last_equity_usd_cents === null ? null : BigInt(account.last_equity_usd_cents),
              positions: account.positions.map((position) => ({
                symbol: position.symbol,
                qty: position.qty,
                marketValueUsdCents: position.market_value_usd_cents,
                avgEntryPriceUsdCents: position.avg_entry_price_usd_cents,
                currentPriceUsdCents: position.current_price_usd_cents,
              })),
              targets: account.targets,
            },
          ],
          skipDuplicates: true,
        });
        snapshotStored = written.count > 0;
      }
      return { status: fresh ? ("recorded" as const) : ("stale" as const), snapshotStored };
    });
  } catch (error) {
    if (isMissingSchemaError(error)) {
      logUnavailable("recordCoreReport", error);
      throw new CoreMirrorUnavailableError(error);
    }
    throw error;
  }
}

// --- reading ---------------------------------------------------------------------------------------------

export type CoreStatusView = {
  reportedAt: Date;
  tradingEnabled: boolean;
  disabledReason: string | null;
  halted: boolean;
  haltReason: string | null;
  policySha256: string | null;
  policyEffectiveFrom: string | null;
  plan: { id: string; kind: string; status: string; executeOn: string } | null;
  journal: { ok: boolean; entries: number; reason: string | null };
  tickAgeSeconds: number | null;
  tickFailures: number;
  attention: string[];
};

export type CoreSnapshotView = {
  takenAt: Date;
  equityUsdCents: number;
  cashUsdCents: number;
  lastEquityUsdCents: number | null;
  positions: CorePositionInput[];
  targets: Record<string, string>;
};

export type CoreMirror =
  | { available: false }
  | {
      available: true;
      status: CoreStatusView | null;
      snapshot: CoreSnapshotView | null;
      /** The current journal, oldest first. */
      entries: RawJournalEntry[];
      chainId: string | null;
      /** How many journals this account has mirrored (more than one means the router's state was reset). */
      chainCount: number;
    };

const StoredPositionsSchema = z.array(
  z.object({
    symbol: z.string(),
    qty: z.string(),
    marketValueUsdCents: z.number().int().nullable(),
    avgEntryPriceUsdCents: z.number().int().nullable(),
    currentPriceUsdCents: z.number().int().nullable(),
  }),
);
const StoredTargetsSchema = z.record(z.string(), z.string());
const StoredAttentionSchema = z.array(z.string());

/**
 * Everything the long-term core page shows, in one user-scoped read: the
 * router's last report, its newest account snapshot, and the current
 * journal. "Current" is the journal whose entries are most recent — a
 * router whose state directory was reset starts a new chain, and the old
 * one stays stored as history rather than being mixed in.
 *
 * Whole-journal read on purpose: verifying a hash chain needs every entry
 * from the first, and a long-term core writes tens of entries a quarter.
 * If that ever stops being small, the page's verification (not this
 * query) is what to make incremental.
 */
export async function getCoreMirror(userId: string): Promise<CoreMirror> {
  try {
    return await withUserScope(userId, async (tx) => {
      const [status, snapshotRow, newest, chains] = await Promise.all([
        tx.coreRouterStatus.findUnique({ where: { userId } }),
        tx.coreSnapshot.findFirst({ where: { userId }, orderBy: { takenAt: "desc" } }),
        tx.coreJournalEntry.findFirst({ where: { userId }, orderBy: { occurredAt: "desc" }, select: { chainId: true } }),
        tx.coreJournalEntry.findMany({ where: { userId }, distinct: ["chainId"], select: { chainId: true } }),
      ]);

      const rows = newest
        ? await tx.coreJournalEntry.findMany({
            where: { userId, chainId: newest.chainId },
            orderBy: { entryIndex: "asc" },
            select: { entryIndex: true, entryHash: true, prevHash: true, rawLine: true },
          })
        : [];

      const positions = snapshotRow ? StoredPositionsSchema.safeParse(snapshotRow.positions) : null;
      const targets = snapshotRow ? StoredTargetsSchema.safeParse(snapshotRow.targets) : null;
      const snapshot: CoreSnapshotView | null =
        snapshotRow && positions?.success && targets?.success
          ? {
              takenAt: snapshotRow.takenAt,
              equityUsdCents: Number(snapshotRow.equityUsdCents),
              cashUsdCents: Number(snapshotRow.cashUsdCents),
              lastEquityUsdCents: snapshotRow.lastEquityUsdCents === null ? null : Number(snapshotRow.lastEquityUsdCents),
              positions: positions.data,
              targets: targets.data,
            }
          : null;

      const attention = status ? StoredAttentionSchema.safeParse(status.attention) : null;
      const statusView: CoreStatusView | null = status
        ? {
            reportedAt: status.reportedAt,
            tradingEnabled: status.tradingEnabled,
            disabledReason: status.disabledReason,
            halted: status.halted,
            haltReason: status.haltReason,
            policySha256: status.policySha256,
            policyEffectiveFrom: status.policyEffectiveFrom,
            plan:
              status.planId && status.planKind && status.planStatus && status.planExecuteOn
                ? { id: status.planId, kind: status.planKind, status: status.planStatus, executeOn: status.planExecuteOn }
                : null,
            journal: { ok: status.journalOk, entries: status.journalEntries, reason: status.journalReason },
            tickAgeSeconds: status.tickAgeSeconds,
            tickFailures: status.tickFailures,
            attention: attention?.success ? attention.data : [],
          }
        : null;

      return {
        available: true,
        status: statusView,
        snapshot,
        entries: rows.map((row) => ({ index: row.entryIndex, hash: row.entryHash, prev: row.prevHash, raw: row.rawLine })),
        chainId: newest?.chainId ?? null,
        chainCount: chains.length,
      } as const;
    });
  } catch (error) {
    if (isMissingSchemaError(error)) {
      logUnavailable("getCoreMirror", error);
      return { available: false };
    }
    throw error;
  }
}
