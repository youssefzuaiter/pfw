import "server-only";
import { withUserScope } from "../db/with-user-scope";

/**
 * Structured AI-strategy telemetry from the Tier-0 paper-trading agent
 * (ad hoc, Phase 4) — see `ScenarioMetrics`'s own schema doc comment for
 * why `decision` is a plain string and `actualFillPrice` is nullable.
 *
 * `shadowPredictedMovePct`/`shadowDecision` (ad hoc, Phase 3's shadow
 * A/B pipeline) are both nullable and always set together — see
 * `ScenarioMetrics`'s own schema doc comment for why the shadow model's
 * `decision` vocabulary is deliberately different from the primary one.
 */
export type RecordScenarioMetricsInput = {
  ticker: string;
  hash: string;
  predictedMovePct: number;
  /** Null at evaluation time (this feature's only writer) — no fill exists yet. */
  actualFillPrice: number | null;
  decision: string;
  shadowPredictedMovePct: number | null;
  shadowDecision: string | null;
  /** The trader's `X-Idempotency-Key` for this delivery; `null` only for a caller that has none (nothing in this app today). */
  idempotencyKey: string | null;
};

/**
 * Every scenario the agent evaluated, oldest first — feeds the Agent
 * Activity page's "predicted move %" area chart (Phase 2, ad hoc). This
 * is the first read path this table has ever had; every prior consumer
 * only ever wrote to it (see this file's own header comment).
 * `predictedMovePct` is stored as a Prisma `Decimal`, which the chart
 * wrapper needs as a plain `number` — converted here, once, rather than
 * in the client component.
 */
export async function listScenarioMetrics(userId: string, since?: Date) {
  return withUserScope(userId, async (tx) => {
    const rows = await tx.scenarioMetrics.findMany({
      where: since ? { userId, createdAt: { gte: since } } : { userId },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true, predictedMovePct: true, ticker: true, decision: true },
    });
    return rows.map((row) => ({ ...row, predictedMovePct: row.predictedMovePct.toNumber() }));
  });
}

/**
 * Idempotent on `idempotencyKey` (trader integration hardening, ad hoc):
 * the trader's durable outbox REPLAYS any delivery whose response it
 * never saw — a 5s client timeout on a cold Vercel lambda is enough to
 * trigger one — and without this a single evaluated scenario would be
 * counted twice on the "predicted move %" chart. Read-then-create
 * inside the same user-scoped transaction, with the `@unique` constraint
 * as the backstop: two concurrent replays of one key race only on the
 * index, and the loser's `P2002` is resolved by re-reading the winner's
 * row rather than surfacing as an error.
 */
export async function recordScenarioMetrics(
  userId: string,
  input: RecordScenarioMetricsInput,
): Promise<{ id: string; created: boolean }> {
  return withUserScope(userId, async (tx) => {
    if (input.idempotencyKey) {
      const existing = await tx.scenarioMetrics.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true },
      });
      if (existing) return { id: existing.id, created: false };
    }

    try {
      const created = await tx.scenarioMetrics.create({
        data: {
          userId,
          ticker: input.ticker,
          hash: input.hash,
          predictedMovePct: input.predictedMovePct,
          actualFillPrice: input.actualFillPrice,
          decision: input.decision,
          shadowPredictedMovePct: input.shadowPredictedMovePct,
          shadowDecision: input.shadowDecision,
          idempotencyKey: input.idempotencyKey,
        },
        select: { id: true },
      });
      return { id: created.id, created: true };
    } catch (error) {
      if (input.idempotencyKey && isUniqueConstraintViolation(error)) {
        const winner = await tx.scenarioMetrics.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
          select: { id: true },
        });
        if (winner) return { id: winner.id, created: false };
      }
      throw error;
    }
  });
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === "P2002";
}
