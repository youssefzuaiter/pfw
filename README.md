# PFW — Personal Finance Workbench

A personal finance app I built and use for my own money: it imports real bank
statements, categorizes spending, tracks budgets, goals, debts and investments,
and mirrors a separate paper-trading system. Money is stored as integer minor
units, every row is scoped to its owner twice (application code + Postgres
Row-Level Security), and the AI features read the ledger through tools rather
than doing arithmetic themselves.

<!-- TODO: screenshot of /dashboard, e.g. docs/dashboard.png -->

## Problem

Banking apps show transactions but answer few real questions: how much is
actually safe to spend this month, when cash runs out at the current burn rate,
what a debt costs under avalanche vs snowball, which charges are quietly
recurring. I wanted one place that answers those from my own data, and that I
trust enough to put that data in.

## Approach

- **Money is never a float.** Amounts are integer agorot (₪125.50 = 12550),
  interest rates are integer basis points (`src/lib/money.ts`, `src/lib/apr.ts`).
  ILS is the base currency; accounts can also be USD, EUR, GBP or TRY, converted
  at the rate on the day of the transaction, not today's.
- **Statement import that checks itself.** CSV and PDF statements (QNB layout
  covered by tests) go through a preview → import pipeline with
  formula-injection neutralization and de-duplication, and a statement is
  refused if its rows don't add up to its own running balance
  (`src/lib/csv-import/`).
- **Categorization cascade.** A deterministic rule engine first, then
  Hebrew-safe pattern matching (`\b` doesn't work next to Hebrew letters, so
  matching uses `\p{L}` lookarounds), then merchant embeddings with pgvector.
- **Financial engines as pure functions** in `src/lib/`: 60-day cash-flow
  forecast, burn-rate runway, debt amortization, envelope budgeting,
  recurring-charge detection, a FIRE Monte Carlo, and a multi-jurisdiction
  capital-gains simulator.
- **Security.** Auth.js with Argon2id passwords, TOTP MFA and passkeys;
  AES-256-GCM field-level encryption with a key-rotation script; an
  append-only audit log; CSRF/Origin checks, idempotency keys and
  Postgres-backed rate limits on every mutating route. Public sign-up is
  closed unless `REGISTRATION_OPEN=true`.
- **AI, kept on a leash.** The Claude advisor answers through 10 read-only
  tools and streams text only. The copilot sidebar can run on a local Ollama
  model instead.
- **Paper-trading mirror.** `/trading` shows signed webhook data from my
  separate `paper-trader` service in its own tables, never mixed into net worth.

## Testing

| Suite | Scope | Last recorded result |
|---|---|---|
| `npm run check` | typecheck, lint, Vitest unit/component/integration | 2,372 passed, 5 skipped |
| `npm run test:e2e` | Playwright: axe-core light/dark, keyboard focus, CSRF/IDOR/XSS/SQLi/rate-limit | 57 passed |
| `npm run test:mutation` | Stryker over the core financial-math engines | 80.75% mutation score (baseline 59%) |

Results as recorded in `AGENTS.md` (§3aaaa for the first two, Phase 3 for
mutation); CI runs typecheck, lint and tests against a throwaway Postgres on
every push, plus Gitleaks and Semgrep. Guard tests in `tests/guards/` enforce
architectural rules, such as no secrets in the client bundle and no
un-tokenized colours.

## How to Run

Needs Node 22 (what CI uses) and Docker.

```bash
npm install
cp .env.example .env
# set ENCRYPTION_KEY and AUTH_SECRET (generator commands are in .env.example);
# ANTHROPIC_API_KEY only if you want /advisor

docker compose up -d     # Postgres 17 + pgvector on localhost:5433, plus Redis
npm run db:migrate       # schema, RLS policies, restricted runtime role
npm run db:seed          # deterministic mock data
npm run dev              # http://localhost:3000
```

The seed creates a demo user with mock Israeli banking data. The
merchant-embedding sidecar (`sidecar/`, FastAPI + ONNX Runtime) is optional;
see `sidecar/README.md`.

Production runs on Vercel with a managed Postgres, a daily cron for exchange
rates and prices, and GitHub Actions for migrations, backups and a smoke check.

## Project Structure

```
src/app/          Next.js 16 routes (App Router) and API handlers
src/lib/          pure money, forecasting, import and categorization logic
src/server/       data-access layer, auth, advisor, env (server-only)
prisma/           schema (47 models) and 45 migrations
tests/            integration, e2e (Playwright) and guard tests
sidecar/          optional embedding service (Python)
ml-pipeline/      autoencoder training for spending-anomaly detection
scripts/          rate/price sync, key rotation, backups, ledger reconciliation
docs/             threat model, ASVS checklist, backup/restore runbook
```

## Limitations

- Built for one person. Multi-user isolation is real (RLS), but sign-up is
  closed and nothing is tuned for many users.
- Statement import covers the bank layouts I've actually used; a new bank
  needs an adapter.
- PSD2 open banking is a mocked simulation with a realistic API shape, not a
  regulated connection to a real bank.
- <!-- TODO: anything else you consider a known gap -->

## Documentation

- `AGENTS.md` — the full build log: every decision, deviation and verification
- `ARCHITECTURE.md` — system overview
- `docs/SECURITY.md`, `docs/SECURITY-CHECKLIST.md`, `SECURITY-REPORT.md` —
  threat model, OWASP ASVS control matrix, point-in-time security report

<!-- TODO: license -->
