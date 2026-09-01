# Future infrastructure

**Nothing in here is deployed anywhere.** These are fully-designed
Kubernetes manifests for running PFW's production stack — a CloudNativePG
Postgres cluster with automated failover/replication/point-in-time
recovery, the app's own Deployment/Service/Ingress, and two CronJobs
(logical backups, the Dead Man's Switch inactivity check) — parked here
rather than deleted.

## Why parked, not deployed

PFW is currently a single-user personal app (see `AGENTS.md` §1). The
operational payoff of a self-hosted, highly-available Postgres cluster
(automated failover, streaming replication, PITR) only shows up once
there are real multiple users depending on uptime. Until then, a free
managed Postgres provider (e.g. Neon) gives the same durability/backup
guarantees that actually matter at this scale, with zero ops burden and
$0/month cost — a better fit for right now than running and maintaining
a real Kubernetes cluster.

## What's already done here (the expensive part)

- The RLS role model (`pfw_app` / `pfw_runtime` / `backup_reader`),
  matching the app's own Prisma migrations exactly.
- Zero-trust network policies (default-deny, explicit allow-lists).
- A two-layer backup strategy: Barman Cloud continuous WAL archiving +
  PITR to S3, plus an independently-scheduled, client-side-encrypted
  logical `pg_dump` CronJob.
- The app's own Deployment/Service/Ingress, wired to the existing
  `/api/health` liveness/readiness routes.

None of this needs to be redesigned later — it's the hard architectural
thinking, already done and reviewed.

## What reactivating this actually takes

Realistically **a day or two of focused work**, not a redesign, when
this app genuinely needs it:

1. Provision a real Kubernetes cluster (a cloud provider, or a VPS +
   k3s) — ~30-60 min.
2. Install prerequisite operators: the CNPG operator, cert-manager (for
   the TLS `ClusterIssuer` these manifests reference), an ingress
   controller if the provider doesn't already supply one — ~30-60 min,
   plus resolving any API-version drift between what these manifests
   assume and whatever CNPG/cert-manager versions are current by then.
3. Wire real secrets: S3 credentials for Barman, the TLS issuer,
   container registry access, DNS for the Ingress host.
4. **Not yet solved by these manifests, worth solving deliberately
   before relying on it**: the Postgres cluster's network policy is
   default-deny to everything except the app's own namespace — which
   means `.github/workflows/deploy-migrations.yml` (a GitHub-hosted
   runner, not inside the cluster) has no path in as written today. A
   real reactivation needs either a bastion/VPN, or restructuring
   `migrate deploy` to run as an in-cluster Job instead of from CI
   directly.
5. Migrate data from wherever production was living in the meantime
   (e.g. Neon) via `pg_dump`/`pg_restore` — quick, at this app's data
   volume.
6. Point `PRODUCTION_DATABASE_URL` (the GitHub `production` environment
   secret) at the new cluster.

## Layout

```
k8s/app/    Deployment, Service, Ingress for the Next.js app itself
k8s/db/     CNPG Postgres Cluster + the logical-backup CronJob
k8s/dead-mans-switch-cronjob.yaml   scheduled inactivity check (§3t)
```
