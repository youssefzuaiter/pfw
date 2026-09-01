import { NextResponse } from "next/server";
import { checkDatabaseConnectivity } from "../../../../server/dal/health";

/**
 * Readiness probe (future-infra/k8s/app/deployment.yaml) — see `/api/health/route.ts`'s
 * own doc comment for why this is a SEPARATE endpoint from liveness, not
 * the same one reused: this one deliberately DOES check Postgres
 * connectivity (a plain `SELECT 1`, via the app's real runtime client —
 * `pfw_runtime`, RLS-scoped, `APP_DATABASE_URL` — the same connection
 * path every real request uses, not a separate admin check), because a
 * pod that's alive but can't reach its database genuinely shouldn't
 * receive traffic. `readinessProbe` failures pull a pod out of the
 * Service's endpoint list without restarting it — the correct response
 * to "temporarily can't serve requests," as opposed to liveness's
 * "this process is broken, restart it."
 *
 * No RLS session-variable scoping needed for a bare `SELECT 1` (nothing
 * user-owned is touched), so this intentionally bypasses `withUserScope`
 * — the one query here needs no `userId` at all. Public
 * (src/proxy.ts's allowlist) — a kubelet probe carries no session.
 */
export async function GET() {
  try {
    await checkDatabaseConnectivity();
    return NextResponse.json({ status: "ok" });
  } catch (error) {
    console.error("GET /api/health/ready: database check failed", error);
    return NextResponse.json({ status: "error" }, { status: 503 });
  }
}
