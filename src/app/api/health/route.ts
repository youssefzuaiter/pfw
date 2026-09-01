import { NextResponse } from "next/server";

/**
 * Liveness probe (future-infra/k8s/app/deployment.yaml) — deliberately checks NOTHING
 * beyond "this Node process can respond to an HTTP request at all," no
 * database touch. A liveness probe's whole job is telling the kubelet
 * whether to RESTART the pod; coupling it to Postgres reachability would
 * mean a transient DB blip (a CNPG failover, a network hiccup) causes
 * Kubernetes to kill and restart every app pod simultaneously — a
 * classic self-inflicted outage that makes a brief dependency wobble
 * into a full app restart storm. That's exactly what the SEPARATE
 * readiness probe (`/api/health/ready`) is for instead: readiness can
 * and should fail when the DB is unreachable (routing traffic away from
 * a pod that can't serve real requests), without also being restarted.
 * Public (src/proxy.ts's allowlist) — a kubelet probe carries no session.
 */
export async function GET() {
  return NextResponse.json({ status: "ok" });
}
