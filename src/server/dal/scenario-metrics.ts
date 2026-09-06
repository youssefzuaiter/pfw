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

export async function recordScenarioMetrics(userId: string, input: RecordScenarioMetricsInput) {
  return withUserScope(userId, (tx) =>
    tx.scenarioMetrics.create({
      data: {
        userId,
        ticker: input.ticker,
        hash: input.hash,
        predictedMovePct: input.predictedMovePct,
        actualFillPrice: input.actualFillPrice,
        decision: input.decision,
        shadowPredictedMovePct: input.shadowPredictedMovePct,
        shadowDecision: input.shadowDecision,
      },
      select: { id: true },
    }),
  );
}
