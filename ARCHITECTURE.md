# PFW — System Architecture

> Verified against the actual working tree and the sibling `~/paper-trader`
> repository on 2026-09-12, not copied from `AGENTS.md`/`README.md` — both of
> those documents have their own, separate staleness (see
> [§9 Documentation drift](#9-documentation-drift-a-known-gap-this-document-does-not-fix)).
> Where this document states a fact about the code, it was read from the
> source at the path given, not assumed.

## Contents

1. [What this is](#1-what-this-is)
2. [System diagram](#2-system-diagram)
3. [Component breakdown](#3-component-breakdown)
4. [Data flow diagrams](#4-data-flow-diagrams)
5. [Security & privacy](#5-security--privacy)
6. [Performance](#6-performance)
7. [Deployment topology](#7-deployment-topology)
8. [Known limitations](#8-known-limitations)
9. [Documentation drift](#9-documentation-drift-a-known-gap-this-document-does-not-fix)

---

## 1. What this is

PFW is a personal-finance web app (mock Israeli banking data, ₪ as the one
reporting currency) plus a simulated equities-trading desk, built as a
single Next.js application backed by Postgres. It integrates with two
**separate, independently-deployed Python services**:

- `sidecar/` — a small FastAPI service that lives *inside this repository*
  (merchant-name embeddings + async anomaly-detection task offloading).
- `~/paper-trader` — a **different repository entirely**, a sentiment-driven
  paper-trading agent against Alpaca's sandbox API, integrated over signed
  HTTP webhooks. It is not a subdirectory of this repo and does not share
  its git history, its Postgres database, or its deploy pipeline.

Getting that boundary right matters for the rest of this document: "the
backend" is not one thing here. There is this app's own Next.js server
(which is also "the backend" for every screen and every DAL call), a
first-party Python sidecar this repo owns and deploys, and a third-party-from-
this-repo's-perspective Python service that happens to be built by the same
person and integrated deliberately. Diagrams below draw that line explicitly.

**Stack, precisely:**

| Layer | Technology |
|---|---|
| Frontend | Next.js 16 (App Router, Turbopack, Cache Components), React 19, TypeScript, Tailwind CSS 4 |
| Charting | Recharts (SVG, personal-finance screens) + `lightweight-charts` (canvas, trading terminal) |
| 3D | React Three Fiber / three.js (`/welcome` hero only) |
| State | Zustand (zk-vault unlock state only) |
| Database | PostgreSQL 17 (`pgvector/pgvector:pg17` image), Prisma 7 (`prisma-client` TS-source generator, no Rust binary, driver adapter via `@prisma/adapter-pg`) |
| Auth | Auth.js (`next-auth@5` beta), Credentials provider, Argon2id, TOTP + WebAuthn passkeys, JWT sessions |
| In-repo Python service | FastAPI + ONNX Runtime + Celery + Redis (`sidecar/`) |
| Sibling Python service | FastAPI + PyTorch + `alpaca-py` (`~/paper-trader`, separate repo) |
| Client-side ML runtime | ONNX Runtime Web (WASM), running in dedicated Web Workers |
| LLM surfaces | Anthropic API (Claude Sonnet 5) for the cloud advisor and the new "AI CFO" chat; Ollama (local, optional) for the privacy-preserving copilot |
| Deployment | Vercel (Next.js app, live — see §7); Render (planned but **not yet applied**, `render.yaml`, for `sidecar/`); Render (paper-trader — see §7's caveat) |

---

## 2. System diagram

```
                                   ┌─────────────────────────────┐
                                   │           Browser           │
                                   │  React 19 UI, PWA/SW cache, │
                                   │  Web Workers (ONNX Runtime  │
                                   │  Web: embed / forecast /    │
                                   │  anomaly-detect — WASM)     │
                                   └──────────────┬──────────────┘
                                                  │ HTTPS
                                                  ▼
                       ┌───────────────────────────────────────────────────┐
                       │      Next.js 16 app  (Vercel — LIVE deploy)       │
                       │                                                   │
                       │  Route groups:                                    │
                       │   (finance)/  dashboard, analytics, budgets,      │
                       │               transactions   — themeable shell    │
                       │   trading/**  desk, portfolio, tax, agent         │
                       │               — fixed-dark "terminal" layout      │
                       │                                                   │
                       │  src/proxy.ts   — CSP nonce, auth gate, public-   │
                       │                    path allowlist                 │
                       │  src/server/dal/**  — every DB access, userId-    │
                       │                        scoped, wraps withUserScope│
                       │  src/app/api/**     — guardMutation() preamble:   │
                       │                        Origin check, rate limit, │
                       │                        session resolution        │
                       └───┬───────────────┬───────────────┬──────────┬────┘
                           │               │               │          │
              Prisma (pg)  │   HTTP        │   HTTP        │  HTTPS   │  HMAC-signed
                           ▼               ▼               ▼ webhooks │  HTTP (outbound)
              ┌────────────────────┐  ┌──────────┐  ┌─────────────┐  ┌▼───────────────────┐
              │   PostgreSQL 17    │  │ sidecar/ │  │  Anthropic  │  │  ~/paper-trader     │
              │  (pgvector image)  │  │ FastAPI  │  │     API     │  │  (SEPARATE REPO)    │
              │                    │  │          │  │ (advisor +  │  │  FastAPI + PyTorch  │
              │ Row-Level Security │  │ /embed   │  │  AI-CFO     │  │                     │
              │ (app.current_      │  │ /health  │  │  chat)      │  │ POST /signals/*     │
              │  user_id session   │  │ /tasks/  │  └─────────────┘  │ POST /analyze/      │
              │  variable, forced  │  │  anomaly-│                   │      transaction    │
              │  on every table)   │  │  detect  │  ┌─────────────┐  │ GET  /health,       │
              │                    │  │ /tasks/  │  │   Ollama    │  │      /account,      │
              │ AES-256-GCM field  │  │  {id}    │  │  (optional, │  │      /positions     │
              │ encryption on a    │  └────┬─────┘  │  loopback-  │  │ POST /control/halt  │
              │ handful of columns │       │        │  only,      │  │                     │
              │                    │       ▼        │  local      │  │ Background:         │
              │ pgvector column    │  ┌──────────┐  │  copilot)   │  │  trading_loop()      │
              │ (semantic search)  │  │  Redis   │  └─────────────┘  │  (autonomous, jittered│
              └────────────────────┘  │ (Celery  │                   │  interval, circuit   │
                                       │  broker  │                   │  breaker, HMAC-signed │
                                       │  +result)│                   │  webhook receipts     │
                                       └────┬─────┘                   │  --> PFW)             │
                                            │                         │                       │
                                            ▼                         │  Talks to:            │
                                    ┌──────────────┐                  │   Alpaca PAPER API    │
                                    │ Celery worker│                  │   (sandbox only,      │
                                    │ (separate    │                  │    structurally       │
                                    │  process)    │                  │    enforced, no live  │
                                    │ ONNX Runtime │                  │    trading path)      │
                                    │ inference    │                  │   FinBERT-shaped      │
                                    └──────────────┘                  │   sentiment model     │
                                                                       │   (placeholder,       │
                                                                       │    deterministic)      │
                                                                       │   Real, TRAINED        │
                                                                       │   PyTorch autoencoder  │
                                                                       │   (per-transaction     │
                                                                       │    anomaly check,      │
                                                                       │    built but not yet   │
                                                                       │    called by PFW)      │
                                                                       └───────────────────────┘
```

Two arrows in the right-hand box are worth calling out explicitly, because
they run in opposite directions and use different trust mechanisms:

- **paper-trader → PFW** (`POST /api/webhooks/trades`, `POST /api/webhooks/metrics`):
  the agent pushes signed trade receipts and scenario telemetry. No user
  session exists on this path — the trust boundary is entirely an
  HMAC-SHA256 signature over the raw request body (`WEBHOOK_SECRET`, shared
  by both services' `.env` files, never sent in a request). Delivery is
  durable on the agent side: a receipt PFW doesn't acknowledge is queued in
  `~/paper-trader/outbox.py` and re-signed/replayed with backoff until it
  is, and both PFW routes dedupe on the receipt's idempotency key so a
  replay can never double-book (AGENTS.md §3uu). `~/paper-trader/reconcile.py`
  closes what the outbox can't: hourly (and at startup) it re-derives a
  settlement receipt for every fill Alpaca reports in the last 24h and
  re-sends it — PFW's idempotency makes that safe, and a fill PFW had
  lost or never seen gets booked. PFW re-prices every
  receipt's native USD amount at its OWN synced FX rate — the agent's
  `exchange_rate_at_entry`/agorot fields are informational only.
- **PFW → paper-trader** (`GET /api/agent/health`, `GET /api/agent/telemetry`,
  `POST /api/agent/halt`): the *browser* never talks to paper-trader directly
  — true without exception since the trader-integration hardening pass
  (AGENTS.md §3uu; before it, the Agent Activity page polled the agent's
  origin from the browser, which needed a loopback CSP exception and could
  never work against the hosted deployment). All three derive the agent's
  origin from ONE setting, `PAPER_TRADER_SERVICE_URL`. `/api/agent/health` is
  a server-side proxy the dashboard polls every 30s (it also reports whether
  the paper-trading account resolves and how many receipts the agent has
  queued but not delivered); `/api/agent/telemetry` relays the agent's
  in-memory event feed to the Agent Activity page every 4s; `/api/agent/halt` is
  signed **server-side**, after `guardMutation()` has already confirmed a
  real authenticated PFW session, specifically so `WEBHOOK_SECRET` never has
  to reach client-side JavaScript (see `src/app/api/agent/halt/route.ts`'s
  own doc comment — this was a deliberate reversal of an earlier "sign it in
  the browser" design that would have leaked the shared secret to anyone
  who opened dev tools).

---

## 3. Component breakdown

### 3.1 Frontend — Next.js, dual UI

Two visually and structurally distinct shells coexist in one app:

- **The finance shell** (`src/app/layout.tsx`, the `(finance)` route group
  plus most other top-level routes): the app's normal light/dark-themeable
  design system (`--pfw-*` CSS tokens, `globals.css`), `Sidebar`/`MobileNav`,
  Recharts for every chart.
- **The trading terminal** (`src/app/trading/layout.tsx`, applies to every
  `/trading/**` route): a fixed dark (`bg-neutral-950`), monospace
  (`font-tabular`, IBM Plex Mono) shell that deliberately does **not**
  respond to the user's light/dark preference — a stated, deliberate
  aesthetic choice for a "dense technical desk," not an oversight. Uses
  `lightweight-charts` (canvas-rendered, TradingView's library) instead of
  Recharts for price/predicted-move charts — a second charting library that
  had sat as an unused dependency since Phase 0 (same "installed early,
  wired up later" pattern this app's own history already has for Zustand
  and `cmdk`).

Other frontend pieces worth naming:

- **Command palette** (`src/components/CommandPalette.tsx`, `cmdk`): a
  Cmd/Ctrl-K launcher, also dormant since Phase 0 until recently wired up.
- **PWA**: `public/manifest.json`, `public/sw.js`, an offline fallback page
  (`src/app/~offline/`), an `offline-banner.tsx` component, and a real
  install-icon set (`public/icons/`) — this app is now installable and has
  a genuine (if basic) offline story, not just a Lighthouse-checkbox
  manifest.
- **AI CFO chat** (`src/app/api/chat/route.ts`): a *third* LLM-backed
  surface, distinct from `/api/advisor` (the original streaming cloud
  advisor, §3d) and `/api/copilot/chat` (the local-Ollama copilot, §3o).
  Built on the Vercel AI SDK (`ai`, `@ai-sdk/react`'s `useChat`), reusing
  the *same* tool registry (`executeAdvisorTool`) and system-prompt builder
  as the original advisor rather than forking a third copy, plus one new
  tool (`getAgentTradeWinRate`) scoped to the trading-agent context this
  chat surface is meant to answer questions about.
- **In-app notifications** (`src/components/notifications/notification-bell.tsx`,
  a `Notification` Prisma model, `GET/POST /api/notifications`): populated
  by `src/app/api/cron/route.ts`, a Vercel Cron-triggered route
  (`vercel.json`, `CRON_SECRET`-gated) — the first genuinely scheduled,
  server-initiated job in this app (every prior "sync" script, §3l/§3v/§3oo,
  was a manual/cron-elsewhere entry point the *deployment* had to schedule;
  this one is scheduled *by the deployment platform itself*).

### 3.2 Data layer — Postgres + Prisma + Row-Level Security

Every table is `userId`-scoped and protected two independent ways:

1. **Application-level filtering** — every DAL function
   (`src/server/dal/**`) takes `userId` as a mandatory parameter and wraps
   its query in `withUserScope`, which sets the Postgres session variable
   `app.current_user_id` inside the same transaction as the query.
2. **Row-Level Security policies** — every table has RLS `FORCE`d, keyed off
   that same session variable. Unset means NULL means no rows match: it
   fails **closed**, not open.

Two Postgres roles exist on purpose: `pfw_app` (superuser, migrations/seed
only) and `pfw_runtime` (the actual app connection, genuinely subject to
RLS — a superuser bypasses RLS by Postgres's own design, so mixing these up
would silently defeat the whole scheme with no error).

Beyond RLS: AES-256-GCM field-level encryption on a handful of columns
(`BankAccount.last4`, `NotableTransaction.description`, TOTP/webhook
secrets), a genuinely append-only `AuditLog` and `LedgerCommit` hash chain
(enforced by revoked grants *and* a trigger, so not even the superuser role
can rewrite history), and one `pgvector` column
(`NotableTransaction.searchEmbedding`) backing semantic transaction search.

The schema has grown far past the original 14-model count documented in
`AGENTS.md`'s Phase-2 section — recent, undocumented-in-`AGENTS.md`
migrations add `ScenarioMetrics`, `HoldingLots`, `Notification`, MFA
recovery-code tables, and an account-lockout table, none of which have a
corresponding `AGENTS.md` ad-hoc section (see §9).

### 3.3 Server layer — the DAL + API hardening pattern

Every mutating API route follows one shared preamble, `guardMutation()`
(`src/server/api/guard-mutation.ts`): resolve the real session
(`getCurrentUser()` — never a client-supplied id), verify the request
`Origin` against the app's own origin (CSRF defense), and apply a
per-route rate limit (`src/server/api/rate-limit.ts`, in-memory sliding
window). Read-only, side-effect-free routes (`GET /api/analytics/monte-carlo`,
`GET /api/agent/health`, etc.) deliberately skip the Origin check but keep
identity resolution and rate limiting.

The two webhook routes (`/api/webhooks/trades`, `/api/webhooks/metrics`) are
the **one deliberate exception** to `guardMutation()` — there is no user
session on that path at all, by design (the caller is a separate process,
not a browser), so the trust boundary is entirely the HMAC signature
described in §2 and §4.

### 3.4 ML / AI surfaces — where PyTorch actually runs (and where it doesn't)

This is the part of the system most prone to being described inaccurately,
so it gets its own careful breakdown. **PyTorch is a training-time-only
tool everywhere in this repository (`~/PFW`)** — it never runs inside a
request that serves a real user. It genuinely does run at request time,
however, inside the separate `~/paper-trader` service.

| Model | Trained with | Served with | Where it runs |
|---|---|---|---|
| Merchant-name embedding (`sidecar/model/embedding_model.onnx`) | **Nothing** — a fixed Johnson-Lindenstrauss random projection, built directly via `onnx.helper` (`sidecar/app/build_model.py`). No PyTorch anywhere in this model's history. | ONNX Runtime (Python) | `sidecar/` (FastAPI), server-side |
| Client-side merchant embedding (Tier 3 KNN, multilingual) | Pre-trained (`Xenova/paraphrase-multilingual-MiniLM-L12-v2`), not trained by this repo | ONNX Runtime Web (WASM) | Browser, `src/lib/embeddings/local-embedder.worker.ts` |
| Cash-flow forecaster | PyTorch (`scripts/train-forecaster.py`, throwaway venv, exports ONNX, deletes the venv) | ONNX Runtime Web (WASM) | Browser, `src/workers/forecaster.worker.ts` |
| Spending-anomaly detector (PFW's own, 30-day window) | PyTorch (`ml-pipeline/train_autoencoder.py`, same throwaway-venv pattern) | ONNX Runtime — **either** the browser (`src/lib/ml/anomaly-worker-handlers.ts`) **or**, as of this session, the `sidecar/` Celery worker (`sidecar/app/anomaly_model.py`) — same model file, same math, two possible serving locations, never PyTorch at serving time in either case | Browser Worker, *or* `sidecar/`'s Celery worker (server-side) |
| Sentiment/price-move signal (`~/paper-trader`) | Not yet — **explicitly a placeholder**: a fixed-weight `torch.nn.Module` over a SHA-256 pseudo-embedding, deterministic in `(ticker, headline)`. Has the real ProsusAI/FinBERT model's I/O contract but not its weights. | **Real PyTorch**, `torch.nn.Module.forward()`, dispatched via `asyncio.to_thread` | `~/paper-trader` (FastAPI), server-side |
| Per-transaction anomaly autoencoder (`~/paper-trader`) | **Real PyTorch training**, on synthetic data (`models/train_autoencoder.py`) — a genuinely trained checkpoint (`models/autoencoder_checkpoint.pt`), not a placeholder | **Real PyTorch**, loaded from the `.pt` checkpoint | `~/paper-trader` (FastAPI), server-side, at `POST /analyze/transaction` — **built, but nothing in PFW currently calls it** (confirmed by grep; no caller exists in `src/`) |

The async-offload work from the immediately preceding session turn
(Celery + Redis in `sidecar/`) exists specifically so the *fourth* row above
has a server-side option that doesn't block a request/response cycle on a
CPU-bound ONNX forward pass — see §4.4 for the actual sequence.

Three separate LLM-backed (not the ML models above — a large *language*
model, called over HTTPS, never trained or hosted by this app) surfaces
also exist: the original streaming cloud advisor (`/api/advisor`, Claude,
10 read-only sandboxed tools), the local-only copilot (`/api/copilot/chat`,
Ollama on loopback, same tool registry, zero cloud calls), and the newer
AI CFO chat (`/api/chat`, Claude via the Vercel AI SDK, same tool registry
plus one trading-specific tool).

### 3.5 External integrations

| Service | Direction | Auth | Purpose |
|---|---|---|---|
| Anthropic API | PFW → | API key (server-only) | Advisor + AI CFO chat completions |
| Ollama (local) | PFW → | none (loopback-only, allowlist-enforced) | Local copilot |
| Frankfurter API | PFW → | none (free, no key) | Daily FX rates |
| CoinGecko | PFW → | none (free, no key) | Crypto spot prices |
| A public EVM RPC (PublicNode, with LlamaNodes/Cloudflare fallback) | PFW → | none | Live on-chain wallet balances |
| Resend | PFW → | API key (server-only) | Password-reset / verification emails |
| Hugging Face Hub | Browser → | none | Multilingual embedding model weights (data only, not executable) |
| `~/paper-trader` | bidirectional | HMAC-SHA256 (`WEBHOOK_SECRET`) | Trade receipts, scenario telemetry, health check, emergency halt |
| Alpaca (paper/sandbox only) | paper-trader → | API key (paper-trader's own `.env`, never reaches PFW) | Simulated order execution — **structurally cannot place a live trade** (`broker.py` hardcodes `paper=True` and re-validates the resolved host) |

---

## 4. Data flow diagrams

### 4.1 A normal authenticated page load (e.g. `/dashboard`)

```
Browser --GET /dashboard--> src/proxy.ts (auth gate, CSP nonce)
                                  |
                                  v
                     getCurrentUser() (Auth.js JWT session)
                                  |
                                  v
                build-dashboard-data.ts (React cache()-wrapped,
                one computation shared across this request's components)
                                  |
                    +-------------+-------------+
                    v             v             v
              DAL calls    pure src/lib/    (optionally) sidecar
           (withUserScope,  engines (debt    /embed for Tier 3
            RLS-enforced)   math, insights,  categorization
                             forecasts)
                    |
                    v
              PostgreSQL (RLS-scoped read)
                    |
                    v
        Server Component renders real HTML --> Browser
                    |
                    v
   Browser Web Workers THEN independently run (client-side, no
   further server round trip needed for these two):
     - forecaster.worker.ts  --> ONNX Runtime Web --> fan chart
     - anomaly-worker.ts     --> ONNX Runtime Web --> alert banner
```

### 4.2 CSV import → categorization (Tiers 0-2 only)

```
Browser (multipart upload)
      |
      v
POST /api/transactions/import
      |
      v
csv-import/pipeline.ts:
  tokenize -> validate each row -> neutralize formula injection
  (leading = + - @) -> per-adapter parse -> dedupe key
      |
      v
Tier 0 (user's own saved rules) -> Tier 1 (exact merchant match,
manually-confirmed history) -> Tier 2 (keyword rules, Hebrew-safe
\p{L}/\p{N} boundary matching)
      |
      v
Tiers 3 (embedding KNN) and 4 (LLM) deliberately SKIPPED for bulk
import — would mean hundreds of network round trips per upload
      |
      v
Insert via withUserScope, one row at a time (field encryption
extension forbids createMany on encrypted columns)
      |
      v
Response: { importedCount, duplicateCount, rejectedCount }
```

### 4.3 A trading-agent webhook round trip

```
~/paper-trader                                    PFW (Next.js)
--------------                                     -------------
trading_loop() wakes (jittered interval)
      |
      v
Circuit breaker check (daily P&L) --> IS_HALTED check
      |
      v
_run_one_cycle(): fetch simulated quote/headline
      |
      v
inference.predict_move() (placeholder FinBERT-shaped
model OR, once real weights are swapped in, the actual
ProsusAI/finbert checkpoint)
      |
      v
execution.py: Tier-0 gates (>=10% predicted gain,
$10 notional cap, stop-loss sizing) -- most scenarios
are REJECTED here; a rejection is a normal 200, not
an error
      |
      v
If approved: broker.py submits a PAPER order to Alpaca
(sandbox host, structurally enforced)
      |
      v
webhook.py signs the receipt: HMAC-SHA256 over
"{timestamp}.{raw_json_body}", sends raw bytes
(never re-serialized)                                     |
      |------------------------------------------------->  POST /api/webhooks/trades
                                                                |
                                                                v
                                              verifyWebhookSignature() --
                                              constant-time compare,
                                              +/-300s replay window
                                                                |
                                                                v
                                              recordPendingPaperTrade() /
                                              settlePaperTradeReceipt()
                                              (userId from server config,
                                              NEVER from the request body)
                                                                |
                                                                v
                                              Trade + NotableTransaction rows,
                                              same envelope/ledger effects
                                              as a manually-entered trade
      |
      v
_log_event() appends to the in-memory
telemetry deque (also separately
POSTed to /api/webhooks/metrics)                          |
      |------------------------------------------------->  POST /api/webhooks/metrics
                                                                |
                                                                v
                                              recordScenarioMetrics() -->
                                              ScenarioMetrics table -->
                                              agent-predicted-move-chart.tsx
                                              (the live event feed itself reaches
                                              agent-telemetry-terminal.tsx via
                                              GET /api/agent/telemetry, a server-
                                              side relay of the agent's deque)
```

### 4.4 Async anomaly-detection offload (built this session, `sidecar/`)

```
Server-side caller                    FastAPI (sidecar)          Celery worker            Redis
-------------------                    ------------------          -------------            -----
POST /tasks/anomaly-detect
(transactions + window_end_date_key)
        |
        v
                                  enqueue_anomaly_detection()
                                        |
                                        v
                                  detect_spending_anomaly.delay(...)  -- publish -->  broker (db 0)
                                        |
                                  returns 202 {task_id}                                    |
        <-------------------------------                                                   v
                                                                          worker picks up task
                                                                                 |
                                                                                 v
                                                              anomaly_features.py: log1p +
                                                              baseline z-score (mirrors the
                                                              browser TS implementation
                                                              byte-for-byte)
                                                                                 |
                                                                                 v
                                                              onnxruntime.InferenceSession.run()
                                                              on the SAME .onnx file the browser
                                                              Worker uses (public/models/
                                                              spending_anomaly.onnx)
                                                                                 |
                                                                                 v
                                                              tier classification, top-
                                                              contributor feature  -- store -->  result (db 1*)
GET /tasks/{task_id}  ------------------------------------------------------------------------------> read
        |
        v
   {status, result}
```

<sub>* On Render, broker and result backend share one connection-string
database (no per-DB-index split available) — see `render.yaml`'s own
comment.</sub>

---

## 5. Security & privacy

Full detail already lives in three existing documents this file
deliberately does not duplicate: `SECURITY-REPORT.md` (root — a
point-in-time snapshot: auth, RLS, the three separate crypto schemes, CSP/
CSRF/rate-limiting, the AI-surface prompt-injection boundary, accepted
risk), `docs/SECURITY.md` (narrative threat model), and
`docs/SECURITY-CHECKLIST.md` (itemized ASVS control matrix). The summary
below only adds what's new since those were last updated, plus the two
things this task explicitly asked about.

**What's genuinely new since `SECURITY-REPORT.md` was written:** the
webhook trust boundary described in §2-§4 (HMAC-SHA256, timestamp-bound
against replay, constant-time comparison — same rigor as every other
secret-derived comparison in this app), and the Celery/Redis task queue
(§4.4) — its trust boundary is "whatever can reach this process's Redis,"
which today means "whatever can reach `localhost:6379`" locally or, on
Render, whatever the platform's private network scoping allows (the
`keyvalue` service's `ipAllowList: []` blocks the public internet
specifically; see `render.yaml`).

**Differential privacy for telemetry — does not exist, stated plainly
rather than fabricated for this document.** A repo-wide search (including
the sibling `~/paper-trader` repository) found no differential-privacy
mechanism, no noise-injection, no k-anonymity/aggregation layer, and no
dedicated "telemetry" subsystem with its own privacy model. What *does*
exist under the name "telemetry":

- `~/paper-trader`'s `GET /telemetry` — an in-memory, bounded (50-entry)
  deque of the autonomous agent's own operational events (wake/sleep/error/
  circuit-breaker/halt). Resets on process restart. Contains no user
  financial data at all — it's the *agent's* activity log, not a user's.
- PFW's `ScenarioMetrics` table (`src/server/dal/scenario-metrics.ts`) —
  per-scenario trading-strategy telemetry (predicted move %, decision,
  a shadow A/B model's parallel verdict) pushed by the same agent.
  User-scoped, RLS-protected like every other table, but **not**
  anonymized, aggregated, or noised in any way — it's plain structured
  data behind this app's ordinary access control, the same privacy
  posture as every other table, no more and no less.

If differential privacy for telemetry is a real requirement rather than a
speculative checklist item, it would need its own scoping conversation
(what's the privacy budget? aggregated over what dimension — per-user, per-
symbol? does it apply to `ScenarioMetrics`, to the paper-trader's own event
log, to something not yet built?) — the same "flag it, don't fabricate a
plausible-sounding answer" treatment this codebase's own history
(`AGENTS.md` §3aa, §3bb) already gives an analogous mismatch between a
request and what actually exists.

---

## 6. Performance

There is **no automated, continuous performance-benchmark suite** anywhere
in this repository or in `~/paper-trader` — no k6/autocannon/Lighthouse-CI
job, no latency-regression gate in CI. What follows is every real,
hand-verified measurement that exists on record, not a fabricated
benchmark table:

| Measurement | Value | Source / method |
|---|---|---|
| Celery anomaly-detection task, real run | **0.07s** (worker log: `succeeded in 0.07114166700011992s`) | Live `curl` round trip against a real Redis + worker this session, `sidecar/` |
| Multilingual client-side embedding model download (quantized) | **~118MB** (q8) vs. ~470MB (fp32) vs. ~23MB (the prior, English-only model) | `AGENTS.md` §3bb, HTTP HEAD against the published Hugging Face files |
| Self-hosted Tesseract.js OCR WASM payload | **~6.8MB** | `AGENTS.md` §3q |
| Self-hosted onnxruntime-web WASM runtime | **~12.9MB** | `AGENTS.md` §3u |
| `/welcome` R3F hero, dynamically-imported chunks | **~238KB gzipped** (4 chunks), confirmed isolated from the shared app bundle | `AGENTS.md` §3f, `next build --webpack` + `ANALYZE=true` |
| Cash-flow forecaster ONNX export | **35,922 bytes** | `AGENTS.md` §3dd, confirmed via `curl` against the served file |
| Spending-anomaly ONNX export | **89,889 bytes** | Confirmed this session (`ls -la public/models/`) |
| `sidecar/`'s full pytest suite (74 tests, incl. a real Redis+worker round trip) | **~5-10s** wall time | Measured this session, `python -m pytest -v --cov=app` |
| Per-route rate limits (a *design* bound, not a load-test result) | 10-30 requests/min depending on route cost | `src/server/api/rate-limit.ts` call sites |

No p50/p95/p99 latency distribution, no requests-per-second capacity
figure, and no load-test result exists for any HTTP endpoint in either
repository. Building one (e.g. `autocannon` against a running `next start`,
or `locust`/`k6` against the sidecar) is a reasonable next step if
performance is a real, ongoing concern — flagged here rather than
estimated, since an invented number would be actively misleading in a
document whose whole purpose is accuracy.

---

## 7. Deployment topology

```
Vercel (LIVE)                    Render (PLANNED, not yet applied)
--------------                    -----------------------------------
Next.js app                       sidecar-web  (FastAPI)
- output: standalone gated        sidecar-worker  (Celery)
  off when process.env.VERCEL     sidecar-redis  (keyvalue, internal-only)
  is set (next.config.ts)         defined in render.yaml (this repo's
- postinstall: prisma generate    root) -- schema verified against
  (no generated client is         Render's real current docs before
  committed; Vercel's own fresh   writing, but `render dashboard` has
  `npm ci` needs this)            never actually been used to apply it

vercel.json: one Cron trigger     Render (separately, ~/paper-trader --
(src/app/api/cron/route.ts)       a DIFFERENT repo/account/service,
                                  inferred from health-client.ts's own
                                  comment about Render free-tier cold
                                  starts -- not independently confirmed
                                  in this pass; no render.yaml/Procfile/
                                  Dockerfile exists in that repo, so if
                                  it is on Render, it's via manually-set
                                  dashboard config, not tracked as code)

Managed Postgres (provider not    Local dev: docker compose up -d
recorded anywhere in this repo's  (postgres:5433 + redis:6379,
history -- AGENTS.md §3pp says    this repo's compose.yaml)
so explicitly)
```

**What "planned but not applied" means concretely**: `render.yaml` exists,
was validated as syntactically correct YAML, and its schema was checked
against Render's real current documentation field-by-field — but no
`render` CLI command or dashboard action has ever been run against a real
Render account in this session or, as far as this repository's history
shows, any prior one. Treat every claim about `sidecar/`'s production
behavior on Render as a *design*, not an *observation*, until someone
actually deploys it and this document (or `AGENTS.md`) is updated with what
was actually observed.

---

## 8. Known limitations

- **`~/paper-trader`'s trained anomaly-detection endpoint
  (`POST /analyze/transaction`) is built but unused.** Nothing in `src/`
  calls it. If the intent was for PFW to get a second opinion from that
  model on top of its own client-side/sidecar anomaly detector, that
  integration doesn't exist yet.
- **Two independent, non-communicating anomaly-detection systems exist**
  for conceptually related but differently-scoped problems: PFW's own
  30-day-window LSTM autoencoder (multi-feature spending pattern) and
  paper-trader's single-transaction 11-feature autoencoder. They were
  built by different features at different times and were never
  reconciled into one system — whether that's the right end state is a
  real, open design question, not a bug.
  A model retrain lands under `public/models/`, outside `sidecar/`'s
  `rootDir` — Render's own "only rebuild on changes inside `rootDir`"
  behavior means a retrained model would **not** auto-trigger a
  `sidecar/` redeploy (documented in `render.yaml`'s own comment; not yet
  worked around).
- **The sentiment/price-move model in `~/paper-trader` is explicitly a
  placeholder** — deterministic, fixed-weight, no real market-sentiment
  signal. Its own README says exactly what would need to change
  (`pip install transformers`, swap `_load_model`'s body) and states this
  plainly rather than letting the FinBERT name imply more than is true.
- **No formal performance benchmark exists** (§6) — every number in that
  section is a real but ad-hoc, one-off measurement, not a repeatable
  benchmark.
- **This document was assembled from two separate repositories' current
  source** (`~/PFW` and `~/paper-trader`) as read on 2026-09-12. Neither
  repository's own primary docs (`AGENTS.md`, `README.md`) were fully
  current at that time (see §9) — if either repo has changed since, parts
  of this document may already be stale, the same risk every snapshot-style
  document carries.

---

## 9. Documentation drift (a known gap this document does not fix)

While researching this document, several real, committed, working features
were found with **no corresponding write-up in `AGENTS.md`**, whose own
stated purpose is to be "the durable source of truth" for exactly this kind
of thing. In commit order (newest first): demo login + backend status badge
+ offline PWA resilience; the AI CFO chat route + canvas charting + PWA
manifest/service-worker; the dual UI architecture + command palette +
dashboard reorder (plus the `ScenarioMetrics`/`HoldingLots` schema
additions); MFA recovery codes + persistent account lockout; Vercel Cron
triggers + the notification schema; and the entire `~/paper-trader` service
this document spends §2-§4 on.

`AGENTS.md`'s own "Key file map" and "Commands" sections are also
independently stale — still describing a Phase-4-era 14-model schema and a
9-screens app, un-updated across dozens of later ad-hoc sections (this
predates the gaps above and isn't new).

This document is accurate as of the investigation behind it, but it is not
a substitute for closing that gap in `AGENTS.md` itself — a natural,
separate follow-up task, not attempted here since it wasn't what was asked.
