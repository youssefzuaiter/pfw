# PFW — Personal Finance & Trading Workbench

A greenfield personal finance operating system and simulated equities-trading
dashboard, built against deterministic mock Israeli banking data in a single
currency (₪). Money is always an integer number of agorot, interest rates are
always integer basis points, every screen is user-scoped behind a DAL +
Postgres Row-Level Security, and an optional Claude-powered advisor answers
questions over your own ledger through 10 read-only tools — never freehand.

**Stack**: Next.js 16 (App Router, Turbopack, Cache Components) · React 19 ·
TypeScript · PostgreSQL 17 · Prisma 7 (driver-adapter, no Rust binary) ·
Tailwind CSS 4 · Recharts · React Three Fiber · Zustand · Anthropic SDK.

This is not a toy scaffold — it's a full 8-phase build with a hardened API
layer, field-level encryption, an automated accessibility/security audit
suite, and mutation-tested financial math. See **`AGENTS.md`** for the
complete build log, architectural decisions, and every known deviation from
plan; see **`pfw-spec.md`** for the original phase-by-phase spec this was
built against.

## Quick start

```bash
npm install
cp .env.example .env
# fill in ENCRYPTION_KEY (see the generator command in .env.example)
# and ANTHROPIC_API_KEY if you want the /advisor screen to work

docker compose up -d      # postgres:17 on localhost:5433 (pfw_local)
npm run db:migrate        # applies schema + RLS policies + runtime role
npm run db:seed           # deterministic mock data for the current month

npm run dev                # http://localhost:3000 (redirects to /dashboard)
```

The merchant-embedding sidecar (`sidecar/`, FastAPI + ONNX Runtime) is
optional for local dev — everything except Tier 3 of the categorization
cascade and one integration test works without it. See `sidecar/README.md`
to run it.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js dev server / production build / production server |
| `npm run typecheck` / `lint` | `tsc --noEmit` / ESLint |
| `npm run test` | Full Vitest run (unit + component + integration projects) |
| `npm run test:unit` / `:component` / `:integration` | One Vitest project at a time |
| `npm run test:e2e` | Playwright — axe accessibility, keyboard navigation, and security checks against a real production build (needs a live Postgres; downloads Chromium on first run) |
| `npm run test:mutation` | Stryker mutation testing over the core financial-math engines |
| `npm run check` | `typecheck && lint && test` — run this before considering any change done |
| `npm run db:migrate` / `db:seed` / `db:studio` | Prisma migrate / re-seed (wipes and regenerates) / Prisma Studio |

## What's here

- **9 screens**: dashboard, transactions, budgets, goals, debts, assets,
  categories, trading, advisor — plus an isolated `/welcome` entry page with
  a Three.js hero (not part of the main app flow; see AGENTS.md §3f).
- **9 DAL modules**, every function `userId`-scoped and enforced twice
  (application-level `where` clause + Postgres RLS).
- **4-tier Hebrew-safe categorization cascade**, **7 ranked insight
  generators**, a **60-day cash-flow forecast**, full **debt amortization /
  avalanche-vs-snowball math**, and **periodicity-based recurring-charge
  detection** — all pure, unit- and mutation-tested functions in `src/lib/`.
- **AES-256-GCM field-level encryption**, an **append-only audit log**
  (enforced two independent ways), and a **Claude advisor** with a verified
  prompt-injection boundary and a bounded tool-use loop.
- An automated **accessibility + security audit** (`tests/e2e/`) — axe-core
  across every screen in light and dark, real keyboard tab-order/focus-trap
  checks, and live CSRF/IDOR/rate-limit/XSS/SQLi tests against the running
  app.

Full architecture, every model, every route, and the reasoning behind each
non-obvious decision live in **`AGENTS.md`** — read it before making changes;
it's the single source of truth this project maintains as it grows.

## Security & compliance docs

- `docs/SECURITY.md` — narrative threat model, data inventory, trust
  boundaries (Tier 2 now / Tier 3 config-only later).
- `docs/SECURITY-CHECKLIST.md` — itemized OWASP ASVS control matrix, kept
  current at the end of every phase, including the Phase 7 accessibility
  audit findings and `npm audit` results.

## Known gaps (deliberate, documented — not oversights)

- **No real authentication yet.** Every request resolves to a single seeded
  demo user server-side. The DAL/RLS `userId`-scoping this depends on is
  already real and load-bearing; only the login/session layer is deferred.
- **No CSV bank-statement import.** `/transactions` supports search, filter,
  sort, and inline recategorization — importing a real statement isn't
  wired up. The planned adapter architecture and formula-injection guard are
  documented in `docs/SECURITY.md` §3.3 but not implemented.
- **No CI pipeline or formal `docs/SECURITY-REPORT.md` yet** — the spec's
  Phase 8 items beyond repo hygiene and this handover.
