-- Shadow A/B pipeline (ad hoc, Phase 3) — two nullable columns on the
-- existing ScenarioMetrics table for a second, non-authoritative
-- model's theoretical verdict. Generated via `prisma migrate diff`
-- against the live dev DB — same established workaround as every
-- migration since §3p. No RLS change needed: ScenarioMetrics already
-- has its tenant_isolation policy from when the table was created
-- (Phase 4), and a plain nullable-column addition doesn't touch it.

-- AlterTable
ALTER TABLE "ScenarioMetrics" ADD COLUMN     "shadowDecision" TEXT,
ADD COLUMN     "shadowPredictedMovePct" DECIMAL(8,4);
