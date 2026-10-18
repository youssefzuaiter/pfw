# PFW — Personal Finance Workbench

**PFW is a personal finance website that I built to run my own money.** You give
it your bank statements and it shows you, in plain numbers, where you stand:
what you own and owe, what you spent and on what, how much of this month's money
is genuinely free to spend, how long your cash would last, and what each choice
(paying off a debt, saving for a goal, investing) does to the picture.

It is not a bank, it does not hold or move money, and it never stores bank
logins. It reads data you give it, does the arithmetic carefully, and shows the
result.

<!-- TODO: screenshot of /dashboard, e.g. docs/dashboard.png -->

## Contents

- [What it is, in plain words](#what-it-is-in-plain-words)
- [The goal](#the-goal)
- [The name](#the-name)
- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Privacy and security](#privacy-and-security)
- [What is simulated](#what-is-simulated)
- [Tech stack](#tech-stack)
- [Testing](#testing)
- [How to run](#how-to-run)
- [Project structure](#project-structure)
- [Limitations](#limitations)
- [Documentation](#documentation)

## What it is, in plain words

Think of it as a workbench for your money rather than a passive tracker. A
tracker shows you a list of transactions. PFW answers questions:

- *How much can I safely spend this month?* After the card bill, the budgets you
  set aside, the recurring bills still to come, your debt payments and your
  goals, what is left.
- *When does my cash run out at this rate of spending?*
- *Which charges are quietly repeating every month, and did one just go up?*
- *Which debt should I pay first, and what does it cost me either way?*
- *If I invest this way, what does retirement look like in a bad market?*
- *Did that statement I imported actually add up?*

It is a website (installable on a phone or computer like an app). You sign in,
add your accounts, import a statement, and the screens fill in from your own data.

## The goal

The project has three aims:

1. **One place that answers real questions from my own data**, instead of five
   apps that each show a different slice.
2. **Numbers I can trust.** Money is stored as whole units (never decimals that
   drift), every statement is checked against the bank's own running balance, and
   every figure can be traced back to the transactions behind it.
3. **A system I trust enough to put my real finances in.** That drives the
   security work: encryption, strict per-user isolation, an audit trail, and
   AI features that read the data through narrow tools rather than seeing it
   all.

It is also a deliberate engineering project: a complete, tested, security-minded
application built end to end, with the reasoning for each decision written down
(see [Documentation](#documentation)).

## The name

**PFW** stands for **P**ersonal **F**inance **W**orkbench.

- *Personal finance*: it is about one person's (or one household's) money, not a
  company's.
- *Workbench*: a place where you do work with the material in front of you. The
  app is meant to be used, not just looked at: import, correct, categorize,
  budget, simulate, decide.

The project's first design document described it as a personal finance
operating system plus a simulated trading dashboard, which is still a fair
description of the scope. "PFW" is also the name used for the repository, the
code and the documents.

## What it does

### The dashboard

- **Net worth**, computed live from your accounts, assets, investments and debts
  (history comes from a nightly snapshot).
- **Safe to Spend**: cash, minus what you owe on cards, minus money already set
  aside in budgets, minus recurring bills and debt payments still due this month,
  minus what your goals need. The card shows how it was reached line by line.
- **Liquidity runway**: how many days your cash and sellable assets last at your
  current spending.
- **Forecasts**: a 60-day cash-flow forecast, plus an experimental
  probabilistic 30-day range that runs in your browser.
- **Attention feed**: budget overruns, unusual spending, goals falling behind,
  concentrated investments, new recurring charges.

### Bringing data in

- **Statement import** from CSV and PDF files. You see a preview first. The
  import is refused if the rows do not add up to the statement's own running
  balance, and it skips rows you already imported. A whole import can be undone.
  Layouts for several banks are built in (including Turkish lira statements), and
  a new bank needs a small adapter.
- **Manual entry**, including in another currency, plus **receipt scanning**
  that reads a photo of a receipt in your browser (the image never leaves your
  device).
- **Multiple currencies**: ₪ is the base currency; accounts and transactions can
  also be in USD, EUR, GBP or TRY. A transaction is converted at the rate of its
  own day, and totals can be shown in the currency you choose.

### Understanding your spending

- **Categorization** that gets smarter in layers: your own rules first, then
  built-in patterns (safe for Hebrew text), then similarity to merchants you
  already corrected, with an optional AI suggestion step you review before
  anything changes.
- **Split a transaction** across several categories.
- **Transfers between your own accounts** are kept out of "income" and
  "spending" so they do not distort the picture.
- **Recently deleted**: deleting is reversible.
- **Tamper-evident history** for each transaction, so an edit made outside the
  app shows up.
- **Search** by meaning, not just exact words.
- **Subscriptions and bills radar**: finds recurring charges, flags price
  hikes, and spots possible forgotten free trials.
- **Monthly review** page (and an optional monthly email).

### Planning

- **Budgets** work as envelopes: money you assign carries forward, and an
  overspend carries forward too, so a budget is a running balance rather than a
  monthly reset.
- **Goals** with progress and pace.
- **Debts** with payoff schedules, a warning when a payment does not even cover
  interest, and a comparison of paying the biggest-interest debt first versus the
  smallest first.
- **Assets** you track by hand (property, pension, vehicles) with a reminder when
  a valuation gets stale, plus read-only tracking of crypto wallets by public
  address.
- **Retirement analytics**: a Monte Carlo simulation of thousands of possible
  market paths to estimate the chance your money lasts.

### Investing (simulated)

- A **trading desk** with mock prices, holdings, profit and loss, and dividends.
- A **capital-gains and tax simulator** for several jurisdictions, with
  tax-loss-harvesting hints.
- A **read-only mirror** of a separate paper-trading service and a long-term
  portfolio account, kept in their own tables and never mixed into your net
  worth.

### AI helpers

- **Advisor**: ask questions about your own finances in plain language. It
  answers through a fixed set of read-only tools and streams text only. It does
  not do arithmetic itself.
- **Copilot sidebar**: the same idea as a side panel, which can run on a model on
  your own computer so nothing leaves it.

### Together and for later

- **Household spaces**: share chosen budgets and accounts with other people, with
  read or write permission.
- **Emergency vault**: encrypted documents that trusted people can unlock only
  after a long period of inactivity, using split keys.
- **Phone alerts** for large expenses, overspent budgets and missing imports.
- **Your data is yours**: download everything as JSON or CSV, or delete your
  account permanently.

## How it works

PFW follows a few rules that apply to every line of code:

- **Money is never a decimal.** Every amount is a whole number of the smallest
  unit (₪125.50 is 12550), and interest rates are whole basis points
  (7.25% is 725).
- **Figures are derived, not stored twice.** Goal progress comes from
  contributions, today's net worth is computed live, and a dashboard total is a
  sum of the transactions under it.
- **Calculations live in plain functions** that take data in and return results
  (`src/lib/`), so they can be tested without a database.
- **Every request is scoped to its owner twice**: in the application code and
  again inside the database, so a bug in one layer does not expose another
  person's data.
- **Hebrew-safe text matching.** Common word-boundary tricks fail next to Hebrew
  letters, so all matching goes through one tested helper.

Screens are server-rendered pages that read through a data-access layer; mutating
actions go through routes that check the origin, the user, a rate limit and, where
it matters, an idempotency key.

## Privacy and security

- Sign-in with a password hashed using Argon2id, optional authenticator-app
  codes, and passkeys (fingerprint or face on your device).
- Sensitive fields (account endings, transaction descriptions, secrets) are
  encrypted at rest, with a key-rotation procedure.
- An append-only audit log and per-transaction tamper evidence.
- Bank logins, card numbers, national ID numbers and dates of birth are never
  stored.
- Public sign-up is closed unless it is switched on explicitly.
- Nightly encrypted backups, a deployment smoke check, and automated secret and
  code scanning on every change.

See `docs/SECURITY.md` and `SECURITY-REPORT.md` for the full picture.

## What is simulated

So nothing here is mistaken for the real thing:

- **Open banking (PSD2)** is a mocked connection with a realistic shape, not a
  link to a real bank. Real data comes in through statement files.
- **Market prices** on the trading desk are generated, not live.
- **The machine-learning models** (cash-flow range, spending-anomaly alert) are
  trained on synthetic data and are demonstrations, not forecasts to rely on.
- **Tax rules** are a simplified simulator, not tax advice.

## Tech stack

Next.js 16 (App Router) and React 19 with TypeScript, PostgreSQL 17 with
pgvector, Prisma 7, Tailwind CSS 4, Recharts, Zustand, Auth.js, and the
Anthropic SDK. An optional small Python service (FastAPI and ONNX Runtime)
handles merchant embeddings, and some models run in the browser through ONNX
and Web Workers. Production runs on Vercel with a managed Postgres.

## Testing

| Suite | Scope | Last recorded result |
|---|---|---|
| `npm run check` | typecheck, lint, Vitest unit/component/integration | 2,372 passed, 5 skipped |
| `npm run test:e2e` | Playwright: axe-core light/dark, keyboard focus, CSRF/IDOR/XSS/SQLi/rate-limit | 57 passed |
| `npm run test:mutation` | Stryker over the core financial-math engines | 80.75% mutation score (baseline 59%) |

Results as recorded in `AGENTS.md`; CI runs typecheck, lint and tests against a
throwaway Postgres on every push, plus Gitleaks and Semgrep. Guard tests in
`tests/guards/` enforce architectural rules, such as no secrets in the client
bundle and no un-tokenized colours.

## How to run

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
merchant-embedding sidecar (`sidecar/`) is optional; see `sidecar/README.md`.

Production runs on Vercel with a managed Postgres, a daily cron for exchange
rates and prices, and GitHub Actions for migrations, backups and a smoke check.

## Project structure

```
src/app/          Next.js 16 routes (App Router) and API handlers
src/lib/          pure money, forecasting, import and categorization logic
src/server/       data-access layer, auth, advisor, env (server-only)
prisma/           schema (47 models) and 44 migrations
tests/            integration, e2e (Playwright) and guard tests
sidecar/          optional embedding service (Python)
ml-pipeline/      autoencoder training for spending-anomaly detection
scripts/          rate/price sync, key rotation, backups, ledger reconciliation
docs/             threat model, ASVS checklist, backup/restore runbook
```

## Limitations

- Built for one person (and household). Multi-user isolation is real, but
  sign-up is closed and nothing is tuned for many users.
- Statement import covers the bank layouts I have actually used; a new bank
  needs an adapter.
- Several parts are simulations (see [What is simulated](#what-is-simulated)).
- There is no license file yet, so no permission to reuse the code is granted.

## Documentation

- `AGENTS.md`: the full build log, with every decision, deviation and verification
- `ARCHITECTURE.md`: system overview
- `docs/SECURITY.md`, `docs/SECURITY-CHECKLIST.md`, `SECURITY-REPORT.md`:
  threat model, OWASP ASVS control matrix, point-in-time security report
- `docs/BACKUP-RESTORE.md`: backup contents and the tested restore procedure
