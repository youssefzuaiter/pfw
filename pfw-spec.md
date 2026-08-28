You are an expert senior full-stack engineer, financial systems architect, and UI/UX designer.

We are building PFW from scratch in this directory: a greenfield personal finance operating system and simulated trading dashboard.
Target Directory: ~/PFW
Stack: Next.js 16 (App Router), React 19, TypeScript, PostgreSQL 17, Prisma 7, Tailwind CSS 4, Recharts, Zustand, Anthropic SDK.

This is a clean-slate build. There is no legacy code to port or maintain.

================================================================================
SECTION 1: THE NON-NEGOTIABLE CORE LAWS
================================================================================
* MONEY IS NEVER A FLOAT: Every monetary figure is stored and calculated as an integer number of agorot (e.g., ₪125.50 = 12550). Formatting occurs in one auditable UI utility driven by a single currency token (₪).
* APR IN BASIS POINTS: All interest rates are stored as integer basis points (e.g., 7.25% = 725 bps).
* SINGLE CURRENCY (SHEKELS): App-wide single currency with mock Israeli banking data. Trading desk prices US equities in shekels.
* HEBREW REGEX BOUNDARY SAFETY: \b fails beside Hebrew characters (ASCII-only). Categorisation regex must use explicit Unicode-aware character boundary guards.
* DERIVED TRUTH: Goal progress is derived dynamically from contributions (never stored redundantly). Daily net worth snapshots are historical; today's value is calculated live.
* SECRETS & AI ISOLATION: The Anthropic API key and database URLs exist server-side only in route handlers. The assistant streams text deltas alone—tool calls, hidden prompts, and chain-of-thought are never exposed to the client. Tools look up data; they never calculate freehand.

================================================================================
SECTION 2: MAXIMUM CYBERSECURITY & DEFENSE-IN-DEPTH (OWASP ASVS BASELINE)
================================================================================
Treat all financial data as mission-critical. Build against OWASP ASVS (Level 1 full + Level 2 for Authentication, Session, and Access Control) and OWASP Top 10. Design for Threat Model Tier 2 (public deployment with mock data) such that switching to Tier 3 (real financial data) requires only configuration changes, not an architectural rewrite.

1. DATA CUSTODY & REFUSAL (TIER 0 DEFENSE):
   - Never store bank login credentials (passwords, PINs, OTPs). Ingestion is handled via offline CSV import.
   - Never store full account numbers or card PANs—store only the last 4 digits plus institution name.
   - Minimise identity collection: no national IDs, dates of birth, or unnecessary PII.

2. AUTHORIZATION & IDOR/BOLA ELIMINATION:
   - Never trust client-supplied user IDs or parameters. Authorization is strictly server-authoritative: Authenticated Session -> Server User Identity -> Data Query.
   - Enforce scoping at the Data Access Layer (DAL) repository, not per route. Every data access function must accept `userId` as a mandatory parameter and enforce `where: { userId }`.
   - Add an automated architectural test asserting that no route handler imports the Prisma client directly (must go through the repository layer).
   - Negative IDOR Integration Tests: User B requesting User A's resource (transaction, budget, debt, goal, asset, trade) MUST return a `404 Not Found` (never a 403, which leaks existence).

3. AUTHENTICATION & SESSION RIGOR:
   - Password hashing: Argon2id (with bcrypt fallback). Plain SHA-256, MD5, or unsalted schemes are forbidden.
   - WebAuthn / Passkeys preferred as the primary factor; TOTP second factor with recovery codes stored hashed.
   - Authoritative server-managed sessions (no unrevokable stateless JWTs). Session cookies must use `__Host-` prefix, `HttpOnly`, `Secure`, `SameSite=Strict`, short TTL, and session ID rotation upon privilege change.
   - No user enumeration: Identical response time and messaging on login, reset, and registration endpoints.
   - Constant-time comparisons (`crypto.timingSafeEqual`) for all tokens, signatures, and secrets.

4. INJECTION, VALIDATION & REPLAY DEFENSE:
   - Zod runtime validation at every trust boundary (routes, server actions, CSV imports, webhooks). Ban mass-assignment (`prisma.create({ data: req.body })`).
   - Ban `$queryRawUnsafe`. If raw SQL is needed, use tagged `$queryRaw` with typed parameterization.
   - CSV & Formula Injection Guard: Reject malformed files. When exporting or processing CSV data, neutralize spreadsheet formula execution by prefixing cells starting with `=`, `+`, `-`, or `@` with a single quote.
   - Idempotency: Enforce unique `Idempotency-Key` headers on all balance mutations, trade submissions, and webhook deliveries to prevent duplicate replay executions.

5. PLATFORM, BROWSER & API HARDENING:
   - Strict Content Security Policy (CSP): Middleware must generate a per-request cryptographically secure nonce using Node's `crypto` module. Enforce `frame-ancestors 'none'`, `object-src 'none'`, and ban `unsafe-inline` and `unsafe-eval`.
   - Security Headers: `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`.
   - React Taint API: Enforce `experimental_taintUniqueValue` to prevent environment variables and raw secret objects from leaking into client bundles. Grep client bundles in CI to verify no `NEXT_PUBLIC_` secrets exist.
   - Strict CORS & CSRF: Ban `Access-Control-Allow-Origin: *`. Verify `Origin` and `Host` headers against an explicit allowlist on state-changing requests.

6. AI ADVISOR & PROMPT INJECTION DEFENSE:
   - Indirect Prompt Injection Defense: Transaction descriptions, merchant names, and CSV memos are untrusted user data. The system prompt must explicitly delimit ledger records from system instructions.
   - Read-Only Sandboxed Tools: The model cannot execute arbitrary SQL, run JavaScript, or mutate records. Tools take strictly typed inputs, query authorized records via the DAL, and return pre-computed numbers.
   - Cost & DoS Backstop: Sliding-window rate limiting on the `/api/advisor` endpoint, request token ceiling, and hard budget caps in the Anthropic Console.

7. DATABASE, ENCRYPTION & AUDIT LOGGING:
   - Local DB Isolation: PostgreSQL 17 container (`pfw_local`) running as a non-superuser role with strict connection limits.
   - Postgres Row-Level Security (RLS) policies as an extra defense-in-depth layer.
   - Field-Level Encryption: AES-256-GCM via Prisma Client extensions for sensitive metadata.
   - Append-Only Financial Audit Log: Record every balance and ledger mutation (who, what, when, before, after).
   - Structured Redacted Logging: Never log passwords, session tokens, API keys, or raw account numbers.

8. REGULATORY & THREAT DOCUMENTATION:
   - Generate `docs/SECURITY.md` (threat model, data inventory, boundary diagram), `docs/SECURITY-CHECKLIST.md` (OWASP ASVS itemized matrix), and `docs/SECURITY-REPORT.md`.
   - Ensure compliance readiness for Israel's Protection of Privacy Law (Amendment 13) regarding financial data minimization and breach readiness.

================================================================================
SECTION 3: NEXT.JS 16 CONVENTIONS & LOCAL ENVIRONMENT
================================================================================
* ASYNC PARAMS: In Next.js 16, `params` and `searchParams` passed into pages, layouts, and route handlers are asynchronous and MUST be awaited (e.g., `const { id } = await params;`). Do not use synchronous Next.js 15 patterns.
* CACHING PARADIGMS: Next.js 16 defaults to nothing being cached. Do not use deprecated `unstable_cache`. Enable `cacheComponents: true` in `next.config.ts` and use the `'use cache'` directive with `cacheLife()` profiles.
* LOCAL DATABASE ISOLATION: Generate a `compose.yaml` using `postgres:17` (not latest) with a named volume (`pgdata`), setting the database name to `pfw_local`, and including a `pg_isready -d pfw_local` healthcheck. The application will connect to this local container.
* CONTEXT MANAGEMENT & MEMORY: In Phase 1, you will create an `AGENTS.md` file documenting these rules. If instructed to `/compact` by the user or if the conversation is cleared, you must immediately read `AGENTS.md` to restore your system context.

================================================================================
SECTION 4: COMPLETE SYSTEM SPECIFICATION
================================================================================

--- 14 DATABASE MODELS (Prisma 7) ---
All tables are strictly scoped to a user ID:
1. User: Single seeded user resolved via a 15-line helper (auth-ready architecture).
2. NotableTransaction: Ledger with idempotent provider-id upserts to prevent duplicate imports.
3. Category: User-defined categories with permanent slugs (renaming preserves links and rules; deletion reassigns transactions to uncategorized).
4. BankAccount: Balances (credit balances stored positive = money owed).
5. Budget: Monthly limits per category with month-progress proration.
6. Goal & GoalContribution: Savings targets with derived progress.
7. Debt & DebtPayment: Debt tracker with APR in basis points and negative amortization warnings.
8. ManualAsset: Off-feed property, vehicles, crypto with valuation freshness timestamps (Fresh/Aging/Stale).
9. PortfolioHolding & Trade: Simulated equity positions with weighted-average cost basis and order blotter.
10. NetWorthSnapshot: Daily historical net worth snapshots.
11. MerchantEmbedding: Shared vector cache (384-dimension embeddings).
12. AuditLog: Append-only ledger of financial mutations.

--- THE MATHEMATICAL & INFERENCE ENGINES ---
* Categorisation Cascade: Tier 1 (Manual user corrections) -> Tier 2 (Deterministic rules) -> Tier 3 (KNN over past corrections) -> Tier 4 (LLM fallback).
* Insight Generation: 7 ranked generators (Budget breaches, spending spikes, cash-flow risks, goal pace, portfolio concentration, recurring charges, transaction review queue) ranked by severity and financial impact.
* Cash-Flow Forecast: 60-day timeline placing recurring items on real dates + historical discretionary spend. Identifies and highlights the absolute minimum cash point, not just the ending balance.
* Debt Mathematics: Closed-form amortisation, extra-payment simulation, avalanche vs. snowball comparisons, and negative amortisation detection.
* Recurring Detection: Periodicity engine (3+ distinct months, coefficient of variation < 0.15), not a keyword list.
* Merchant Embeddings: FastAPI sidecar running ONNX Runtime serving 384-dimension vectors (no runtime PyTorch).

--- THE 9 PRIMARY SCREENS ---
* /dashboard: Net worth hero, ranked attention feed, 60-day cash-flow forecast, category spending donut, income vs expense history.
* /advisor: Claude assistant with 10 read-only database query tools over the user's ledger.
* /transactions: Full ledger with search, category filters, sorting, and inline recategorisation training.
* /budgets: Category limits, utilization metrics, tiered alerts (80% warning, 100% breach), and month-progress proration.
* /goals: Targets, contribution logs, pace indicators, and projected completion dates.
* /debts: Balances, payoff timelines, avalanche vs. snowball models, and negative amortization flags.
* /assets: Manual asset values and valuation staleness indicators.
* /categories: Category management (create, rename, archive, safe-delete remapping).
* /trading: Simulated terminal with mock order execution, watchlist, interactive price chart, P&L, and trade blotter.
* Mobile Navigation: 4 primary navigation items + "More" drawer (never crowd 7 tabs into a 375px bar).

================================================================================
SECTION 5: DESIGN SYSTEM & UIVERSE INTEGRATION RULES
================================================================================
* Aesthetic: Linear + modern Bloomberg terminal + premium fintech. Clean, data-dense, minimal editorial.
* Theming: Explicitly designed tokens in CSS custom properties for Light, Dark, and System modes (never flip lightness channels automatically).
* Typography: Display face for headers, clean body face, and a strict tabular-figures face for financial tables/figures so columns align vertically.
* UIverse Animation Rules:
  - Convert raw HTML/CSS to React 19 / Tailwind 4 conventions (className, htmlFor, tabIndex).
  - Namespace all custom keyframes and utility classes (e.g., `uv-` prefix) in globals.css.
  - Animate transform and opacity only (never top/left/width/height) to preserve compositor performance.
  - Replace every hardcoded hex code with PFW design tokens.
  - Ensure every interactive element retains a `focus-visible:ring-2 focus-visible:ring-ring` focus indicator meeting 3:1 contrast.
* 3D Rules:
  - CSS 3D Tilt: Max 8 degree tilt, gated to `@media (hover: hover) and (pointer: fine)`. Never apply tilt to cards containing active figures being read.
  - React Three Fiber Hero: Landing/entry canvas only (never behind active ledger numbers). Dynamic runtime extraction of CSS token colors; loop gated by `frameloop="demand"` and `IntersectionObserver`.

================================================================================
SECTION 6: EXECUTION PROTOCOL (GATED PHASES)
================================================================================
Do NOT attempt to build this application in one pass. We will execute in 9 strictly gated phases. At the end of each phase, STOP, present what was built and verified, and wait for my explicit approval before continuing. Security controls execute continuously within each phase.

### PHASE 0 — Product, Architecture & Threat Model Plan (NO CODE)
1. Propose the design system: 4-6 named hex values mapped to CSS tokens, typography pairings (including tabular numbers), ASCII wireframe of /dashboard, and the application's unique signature UI element.
2. Initialize `docs/SECURITY.md` detailing the Tier 2 threat model, attack surfaces, and data minimization plan.
3. Provide recommendations on the 4 critical architectural decisions:
   - User Scoping vs. Full Auth implementation.
   - Retirement assets (Pension/Keren Hishtalmut) inclusion in the schema.
   - Single-currency vs. multi-currency cost-benefit.
   - Bank CSV import adapter architecture with formula injection protection.
4. Propose the detailed build order for the engine and screens.
STOP AND WAIT FOR APPROVAL.

### PHASE 1 — Foundations, Environment, & Security Guardrails
1. Scaffold Next.js 16 with React 19, TypeScript, and Tailwind CSS 4. Verify compatibility against installed package declarations.
2. Update `next.config.ts` to enable `cacheComponents: true` and configure strict response security headers.
3. Generate `compose.yaml` for PostgreSQL 17 with a named volume and healthcheck for `pfw_local`.
4. Create `globals.css` with the design tokens and the `@media (prefers-reduced-motion)` guard.
5. Build the integer money primitives and APR utilities with unit tests.
6. Establish Next.js Middleware generating CSP crypto nonces and configure React Taint API.
7. Establish test suites (Unit, Component, and DB Integration) with mutation checking.
8. Implement guard tests: Fail build on untokenized hex literals, missing `focus-visible` rings, missing motion guards, direct Prisma imports in routes, or `dangerouslySetInnerHTML`.
9. Create `AGENTS.md` and `docs/SECURITY-CHECKLIST.md` (OWASP ASVS mapped).
STOP AND WAIT FOR APPROVAL.

### PHASE 2 — Data Layer, Encryption & Scoping
1. Implement the Prisma 7 schema covering all models with idempotent upserts, permanent category slugs, and user scoping.
2. Implement PostgreSQL Row-Level Security (RLS) policies and AES-256-GCM field-level encryption on sensitive columns.
3. Implement the append-only `AuditLog` model.
4. Create the deterministic database seeding engine: Monthly-seeded RNG producing reproducible Israeli mock data.
5. Write negative IDOR integration tests: User B accessing User A records must return 404.
STOP AND WAIT FOR APPROVAL.

### PHASE 3 — Mathematical & Inference Engines
1. Build and test the 4-tier Categorisation Cascade with Unicode Hebrew boundary safety.
2. Implement the 7 Insight Generators, 60-day Cash-Flow Forecasting function, Debt Math suite, and Periodicity Recurring Detection engine.
3. Build the FastAPI ONNX sidecar interface for 384-dimension merchant embeddings.
4. Run mutation-checking on all financial calculation tests.
STOP AND WAIT FOR APPROVAL.

### PHASE 4 — Core Screens & Hardened API Layer
1. Build backend API routes (~17 routes) and DAL modules enforcing Zod validation, request-scoped caching, sliding-window rate limiting, and Idempotency-Key verification.
2. Ensure ALL Next.js 16 route/page params and searchParams are properly awaited.
3. Build `/dashboard` and `/transactions` first (desktop + mobile layouts).
4. STOP to allow review of these two core screens in both light and dark themes.
5. Once approved, implement the remaining 7 screens: `/advisor`, `/budgets`, `/goals`, `/debts`, `/assets`, `/categories`, `/trading`.
6. Implement the Claude Advisor route streaming text deltas backed by 10 read-only sandboxed tools with least-privilege DB credentials and prompt injection boundary isolation.
STOP AND WAIT FOR APPROVAL.

### PHASE 5 — UIverse Micro-Interactions & CSS 3D
1. Implement custom micro-interactions (buttons, toggles, badges, loaders) following UIverse patterns adapted to Tailwind 4 tokens.
2. Implement CSS 3D subtle tilt effects on promotional/category cards.
3. Verify that all animations halt under `prefers-reduced-motion` and no live financial numbers are animated.
STOP AND WAIT FOR APPROVAL.

### PHASE 6 — Three.js Landing Visual (Optional/Isolated)
1. Build an isolated R3F hero component on the entry surface using dynamic CSS token color extraction and demand-based frame loops.
2. Verify JS bundle footprint via `@next/bundle-analyzer` (must not exceed ~250KB gzipped).
STOP AND WAIT FOR APPROVAL.

### PHASE 7 — Verification, Accessibility & Security Audit
1. Run `npm run check` (typecheck, lint, full test suite).
2. Execute automated `axe` accessibility testing on all 9 routes in both light and dark themes.
3. Run security test suite: Verify IDOR negative tests (404), CSRF rejection, SQLi fuzzing, XSS script injection, rate-limit enforcement, and CSV formula neutralization.
4. Verify keyboard tab navigation across all interactive controls.
STOP AND WAIT FOR APPROVAL.

### PHASE 8 — CI, Hardened Pipeline & Final Audit Report
1. Setup GitHub Actions workflow: Run typecheck, lint, Semgrep SAST, Gitleaks secret scanning, dependency vulnerability audit (`npm audit`), and integration test suite against a throwaway Postgres container.
2. Verify production build output (`next build`).
3. Output `docs/SECURITY-REPORT.md` and the final Engineering Report detailing created files, models, API routes, test coverage, and benchmark results.

================================================================================
START NOW: Begin with PHASE 0. Provide the design plan, token proposals, ASCII layout, architectural trade-off recommendations, threat model draft, and self-critique. Do NOT write any application code yet.