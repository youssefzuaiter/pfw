# PFW Security Report

**Status:** point-in-time snapshot, produced 2026-08-31.
**Scope:** this document reports the platform's *actual, current* security
posture — every claim below is backed by either a real test in this
repository (`npm run test`), a live-verified check against a running
instance (documented in `AGENTS.md`'s per-feature notes), or an explicit,
named exception. It supersedes the "not produced yet" note that has stood
in `docs/SECURITY.md` since Phase 7.
**Relationship to other security docs:** `docs/SECURITY.md` is the
narrative threat model (attack surfaces, data inventory, trust
boundaries) and `docs/SECURITY-CHECKLIST.md` is an OWASP ASVS itemized
matrix — both are living documents updated per-phase. **Known gap, stated
plainly rather than silently left implicit:** neither has been fully
refreshed since real authentication (§3ff) and the Web-Worker crypto
hardening pass (§3x) landed — several of their status markers (e.g.
`SECURITY-CHECKLIST.md`'s Argon2id/session-management rows, still marked
`⬜ deferred`) are stale as of this report. This document reflects the
system as it actually is today; a follow-up pass to bring those two files
back in sync is recommended but out of this report's own scope.
**Owner:** engineering (single-maintainer project). **Audience:** anyone
evaluating whether to trust this app with real financial data before a
Tier 3 deployment decision (see §1 below) — this report does not make
that decision, it states the facts a decision would be based on.

---

## 1. Deployment tier and what this report covers

PFW runs today at **Tier 2**: synthetic, deterministically-seeded mock
Israeli banking data. No real bank credentials, no real balances, no real
national identity data exist anywhere in this system — by construction,
not by policy (see §7). A **Tier 3** deployment (real linked bank data,
real identity) is explicitly out of scope for what's shipped, and would
require the operational steps in §9, not a re-architecture — every
control in this report (RLS, DAL scoping, field encryption, audit
logging, CSP) is already written to Tier 3's bar, deliberately, from the
schema up.

---

## 2. Authentication

**Argon2id password hashing, real Auth.js v5 sessions** — landed in
AGENTS.md §3ff, replacing the original Phase 0 hardcoded single-demo-user
bet.

- `POST /api/auth/register` creates a real `User` row (or claims the
  original unclaimed seeded demo row — the *first* registration only,
  confirmed by a dedicated integration test that proves it never touches
  a household member's row) with a Argon2id password hash
  (`argon2@0.45.1`, the current recommended KDF for password storage —
  not bcrypt/PBKDF2). `verifyCredentials` returns `null` uniformly for an
  unknown email, an unclaimed row, and a wrong password — a login form
  can't be used to enumerate which emails have accounts.
- **JWT session strategy**, not database-backed sessions — a deliberate
  choice, not a shortcut: `@auth/prisma-adapter` targets Prisma's
  standard `prisma-client-js` output shape, and this app's Prisma 7
  generator (`prisma-client`, real TS source) was never verified against
  that adapter; JWT sessions need no adapter at all, sidestepping the
  question. This also keeps a long-standing architectural bet true: no
  `Session` table has ever existed in this schema (AGENTS.md decision
  #1), and it still doesn't.
- **`getCurrentUser()`'s external contract never changed** when real auth
  landed — it still always resolves to a real `User` row or throws,
  never returns `null`. Every one of this app's dozens of existing
  page/route call sites needed zero changes. The actual gate is
  `src/proxy.ts` (Next middleware): unauthenticated + a protected page →
  `307` redirect to `/login`; unauthenticated + a protected `/api/**`
  route → a plain `401` JSON response (an API client expects JSON, not a
  redirect). `getCurrentUser()`'s own "no session" branch is defense in
  depth, expected unreachable, and throws loudly rather than attempting
  a fragile in-handler redirect (this app has a *documented*, previously
  fixed bug class where an in-render redirect under `cacheComponents`
  silently degrades to a `200` instead of a real HTTP 3xx — see AGENTS.md
  §3c bug #1 — which is exactly why the gate lives in `proxy.ts`, ahead
  of any React rendering, not inside a page body).
- **Explicitly NOT built, a scope decision, not an oversight**: no
  WebAuthn/passkeys, no TOTP/MFA, no "forgot password" flow, no email
  verification (an email here is an identifier, not a proven-reachable
  address), no login-attempt lockout beyond the registration endpoint's
  own per-email rate limit. None of the alternatives to Credentials
  (OAuth, WebAuthn) could be built *and verified* in this environment —
  there is no registered OAuth app or outbound email infrastructure to
  build against — so Credentials was the only strategy that could ship
  and be tested end to end rather than left as an unverified stub. A
  lost password today means an operator resetting it directly against
  the database; this is a real, honestly-stated gap for a Tier 3
  deployment, not a hidden one.

**Verified live**, not just unit-tested: the full real flow was run
against a running dev server — unauthenticated access to a protected
page and a protected API both correctly gated (`307`/`401`), a real
Argon2id registration confirmed via direct database inspection, a full
CSRF-handshake Auth.js login (`GET /api/auth/csrf` →
`POST /api/auth/callback/credentials`) producing a real session cookie
that then unlocked protected routes, sign-out genuinely clearing the
session, a duplicate-email registration correctly `409`, a wrong password
correctly rejected with no session issued.

---

## 3. Authorization and multi-tenant isolation

**Two independent layers, by design — a bug in either one alone does not
compromise the other.**

1. **The Data Access Layer (DAL) is the primary control.** Every read/
   write in this application flows through `src/server/dal/*` (now 20+
   modules covering every domain: bank accounts, transactions, debts,
   goals, categories, budgets, manual assets, portfolio/trades, net
   worth, subscriptions, dead man's switch, shared groups, crypto
   wallets, exchange rates, and more). Every DAL function takes `userId`
   as a mandatory parameter and filters on it explicitly.
   `tests/guards/dal-boundary.test.ts` fails the build the instant a
   route handler imports Prisma directly, which is what makes "every
   read goes through the DAL" an enforced invariant, not a convention
   that can silently rot.
2. **Postgres Row-Level Security (RLS) is the defense-in-depth backstop.**
   Every user-owned table has `FORCE ROW LEVEL SECURITY` and a policy
   keyed on `set_config('app.current_user_id', ...)`
   (`src/server/db/with-user-scope.ts` sets this inside the same
   transaction as every query). Unset means NULL means no rows match —
   RLS fails **closed**, not open. Two Postgres roles make this
   meaningful: `pfw_app` (superuser, migrations/seeding only) vs.
   `pfw_runtime` (`NOSUPERUSER NOBYPASSRLS`, what the running application
   actually connects as). A handful of tables genuinely need finer
   policies than one blanket rule (`GroupMember`'s self-service
   privilege-escalation guard; `SharedGroup`'s ownership-transfer
   widening added this session), each documented at the point it
   deviates from the standard shape.
3. **IDOR is proven, not assumed.** `tests/integration/idor.test.ts` and
   every feature-specific integration suite added since (household
   spaces, the dead man's switch, crypto wallets, tax simulation) proves
   User B requesting User A's resource gets `null`/`404` from the DAL —
   never a `403`, which would confirm the resource's existence to an
   attacker. A small number of narrowly-scoped, individually-documented
   RLS-bypassing "admin client" exceptions exist (`getCurrentUser()`'s
   own bootstrap, invite-acceptance flows, the dead man's switch's
   recovery/inactivity-check paths) — each is allowlisted by name in
   `tests/guards/admin-client-boundary.test.ts`, so the RLS-bypass
   surface stays small, named, and auditable rather than silently
   growing.

---

## 4. Cryptography

PFW runs **three separate, deliberately non-interchangeable cryptographic
schemes**, each solving a different trust problem — conflating them would
misrepresent what each one actually guarantees.

### 4.1 Server-held field-level encryption (AES-256-GCM)

`src/server/crypto/field-encryption.ts`, transparent via a Prisma Client
extension. Covers `BankAccount.last4` and `NotableTransaction.description`
— fields the server legitimately needs to read (search, the
categorization cascade, the AI advisor). Versioned ciphertext format
(`v1:iv:tag:ciphertext`) specifically to allow a future key-versioning
scheme without an ambiguous read of old rows. `authTagLength: 16`
explicitly pinned (a Semgrep-flagged, now-fixed hardening: without it,
`setAuthTag()` accepts any GCM-valid tag length instead of only the
16-byte tag this format has always produced — a truncated-tag-forgery
gap, closed, confirmed by re-running the module's own round-trip tests
after the fix).

### 4.2 Zero-knowledge client-side encryption

Two genuinely separate vaults, each solving a different problem, each
with its own key-custody model — the difference between them is
load-bearing, not cosmetic:

- **The goal-notes vault** (`src/lib/zk-crypto.ts`, `zk1:` format):
  PBKDF2-HMAC-SHA256 (600,000 iterations, OWASP's 2023 minimum) derives a
  **non-extractable** AES-256-GCM `CryptoKey` — the raw key bytes can
  never be pulled back out of the browser, by platform-level construction,
  not merely by convention. True zero-knowledge: the server stores only
  a salt, an iteration count, and ciphertext, and can never decrypt a
  `zk1:` value, ever, under any circumstance. **Passphrase rotation**
  (added this session) decrypts every note with the old key, re-encrypts
  with a freshly-derived new key, and persists the new salt/canary/every
  re-encrypted note atomically in one Postgres transaction — with a
  concurrent-edit guard that fails the whole rotation closed if a note
  changed between the client's read and the write, rather than silently
  dropping or overwriting it.
- **The Emergency Vault** (`src/lib/dead-mans-switch-crypto.ts`, `dms1:`
  format): deliberately derives its own, **separately-salted, extractable**
  key — Shamir's Secret Sharing fundamentally requires exportable raw key
  bytes to split, which the goal-notes vault's key can never provide by
  design. This is a real, different, and *weaker-sounding but
  functionally necessary* security property (recoverable custody vs. true
  zero-knowledge), documented as such rather than conflated with §4.2's
  first bullet. Shamir splitting itself now runs through
  `secrets.js-grempe`, a Cure53-audited library (report shipped inside
  the installed package, independently checkable) — replacing this
  project's original hand-rolled GF(256) implementation after a real bug
  was found in it (the wrong field generator, silently producing a field
  1/5 the size it needed). Beneficiary re-splitting and passphrase
  rotation (both added this session) both re-verify the current
  passphrase before touching any cryptographic state, and both
  invalidate every existing beneficiary share the moment they succeed
  (a resplit is a fresh polynomial — even a beneficiary whose slot didn't
  change gets a brand-new share/link, never a stale one silently left
  valid).
- **The one deliberate, narrowly-scoped, documented server-side plaintext
  exposure in the whole system**: migrating a legacy (pre-vault)
  goal-note, and reconstructing the Emergency Vault's master key during a
  real beneficiary recovery, both require the server to hold plaintext
  momentarily — the same unavoidable handoff moment any real end-to-end
  encryption migration or key-recovery ceremony needs. Both are
  documented at the exact code location, never logged, never cached,
  never persisted beyond the one response that needs them.

### 4.3 Web Worker key isolation

Every PBKDF2/AES-GCM operation for both vaults above runs inside a
dedicated Web Worker (`src/lib/workers/`), not the main thread. A Worker
is a genuinely separate V8 isolate/heap — the derived key lives in a
closure the main thread has no *mechanism* to read, which is a real
security boundary against an XSS payload running in the page's own
realm, not just against network observation (which non-extractable keys
already covered). A shared, tested RPC protocol
(`worker-rpc.ts`) connects the main thread to each worker; an integration
test explicitly asserts no message ever crossing that channel contains
the string `"CryptoKey"`.

### 4.4 On-chain / EVM address handling

Public wallet addresses only — no private key or seed phrase field
exists anywhere in the schema, the DAL, or the UI (the same "never store
a credential" law that governs bank data, applied to its on-chain
equivalent). **EIP-55 checksum validation** (added this session, via
`viem` — already an installed dependency, no new one added) closes what
was previously a stated, honest limitation: a mixed-case address is now
verified against its true Keccak-256 checksum before being accepted,
catching a typo/miscapitalized address at entry time instead of silently
tracking a wallet that will never match a real balance. Verified live,
not assumed from the library's documentation: this pass discovered by
direct execution that the installed `viem` version's strict validator
accepts an all-lowercase address (no checksum info to violate) but
**rejects** an all-uppercase one — a real, non-obvious behavior that
differs from a common paraphrase of the EIP-55 spec, documented plainly
in `src/lib/crypto/evm-address.ts` rather than assumed.

---

## 5. Application-layer controls

- **Content Security Policy**: per-request nonce, `strict-dynamic`,
  `frame-ancestors 'none'`, `object-src 'none'`, no `unsafe-inline`, no
  broad `unsafe-eval` (`'wasm-unsafe-eval'` is scoped narrowly to WASM
  compilation for the client-side OCR and embedding-model features —
  still blocks `eval()`/`new Function()`). A handful of narrow
  `connect-src` exceptions exist for specific, documented third-party
  data fetches (OCR language data, embedding model weights) — never for
  executable script, which stays `'self'`-only. Verified live against a
  real production build in a real browser more than once, including
  re-verification each time a new dynamic route segment shape appeared
  (this app's history includes a real, previously-fixed bug where a
  statically-prerendered page shipped scripts with no nonce at all under
  this exact policy).
- **CSRF / Origin verification**: every mutating route runs through a
  shared `guardMutation()` preamble that checks the request's `Origin`
  against the expected host using a constant-time comparison
  (`crypto.timingSafeEqual` — defense-in-depth; Origin/Host aren't
  secrets, so this isn't closing a real timing side-channel, but it's a
  cheap, correct habit). A missing `Origin` header is allowed, not
  rejected, per OWASP's own CSRF guidance (some legitimate same-origin
  requests omit it) — a forged cross-origin `Origin` gets a `403`,
  verified live and in an automated e2e suite.
- **Rate limiting**: a sliding-window limiter fronts every mutating
  route via the same `guardMutation()` preamble, with tighter limits on
  genuinely expensive endpoints (the AI advisor, the Monte Carlo
  simulator, tax simulation). Verified both by unit test and by firing
  31 rapid identical requests at a real running route and observing the
  429 with a `Retry-After` header.
- **Input validation**: Zod at every trust boundary — every request body,
  every AI-tool-call argument (tool arguments are untrusted input
  crossing a trust boundary exactly like an HTTP body, regardless of
  arriving from a model rather than a browser), every query parameter on
  every GET compute endpoint.
- **Injection**: no `$queryRawUnsafe` anywhere in the codebase — the only
  raw SQL is parameterized `$executeRaw`/`$queryRaw` tagged templates
  (RLS's `set_config`, the pgvector semantic-search ranking query, which
  was specifically checked against the field-encryption Prisma extension
  to confirm raw SQL correctly bypasses it — meaning a raw-SQL row fetch
  would have returned ciphertext, not plaintext, which is why that query
  only ever ranks by id and re-fetches full rows through the normal,
  extension-wrapped Prisma path). CSV import applies a formula-injection
  guard (`= + - @` → prefixed with `'`) scoped to free-text fields only,
  with a regression test proving a legitimate negative amount (`-125.50`)
  is never mistaken for an injection target.
- **XSS**: zero `dangerouslySetInnerHTML` call sites outside one
  allowlisted, zero-interpolation inline script (the theme-flash-prevention
  blocking script). A stored-XSS payload planted directly in the database
  (`<img src=x onerror="...">` as a transaction's merchant name) was
  loaded in a real browser and confirmed to render as inert literal text,
  never execute — React's default escaping, verified, not assumed.
- **Secrets never reach the client**: `src/server/env.ts` is the sole
  reader of every secret, guarded by `server-only`, with a build-output
  scanner (`npm run verify:client-bundle-secrets`) that greps every file
  actually shipped to the browser for the literal value of every secret
  currently loaded — re-run after every build this session touched, zero
  findings, including for the newest additions (`AUTH_SECRET`, the
  crypto-wallet RPC endpoint config).

---

## 6. AI surfaces (cloud advisor + local copilot)

Both the cloud advisor (`/advisor`, Anthropic) and the local-LLM copilot
(`/`, Ollama) share the identical tool registry, the identical Zod
re-validation of model-supplied arguments, and the identical RLS-backed
DAL calls underneath — not similar code, the *same* code, imported
unchanged rather than forked. Both:

- Stream (or, for the non-streaming local copilot, return) **text only**
  — tool names, arguments, results, and any model reasoning never leave
  the server process. Verified live against the real Anthropic API.
- Treat every tool-result free-text field (a merchant name, a
  description) as **inert data, never an instruction** — the system
  prompt says so explicitly, and this was verified live, not just
  written: a transaction's merchant name was set to a real prompt-
  injection payload via the admin client, and the running advisor
  correctly flagged it as a tampering attempt, refused to comply, and
  never emitted the planted "confirmation" string.
- Are bounded: a fixed round-trip cap on tool use, a token-output
  ceiling, and — a real bug caught and fixed this history, not
  theoretical — a check that a tool call is only ever executed on a
  round where tools were actually offered, closing a path where a
  confused or adversarial local model could otherwise smuggle an extra
  DAL round-trip past the round cap on the forced-final turn.
- The local copilot additionally checks its configured Ollama endpoint
  against a loopback/RFC1918-private allowlist **before every single
  request** — a misconfigured remote host is refused outright, not
  silently used, which is what actually makes "zero financial text
  reaches a cloud provider" a checked invariant rather than a
  configuration hope. Unit-tested including the exact RFC1918 boundary
  (172.16–172.31 accepted, 172.32 correctly rejected).

---

## 7. Data minimization

Never stored, anywhere in the 20+-model schema: bank login credentials,
OTPs, full account numbers/PANs (last 4 digits + institution name only),
national IDs, dates of birth, private keys, or seed phrases. This is an
architectural constraint (no such column exists), not a policy asking
developers to remember not to add one. Where an on-chain feature reads a
crypto wallet, only the *public* address and chain id are stored; the
live balance itself is never persisted (derived truth — a live figure
that could go stale would violate this app's own "never store what can
be computed fresh" law).

---

## 8. Automated security pipeline

- **`tests/guards/*`** (part of `npm run test`, so a violation fails the
  build, not a later review): no direct Prisma import in a route handler,
  no untokenized hex color, no `dangerouslySetInnerHTML` outside one
  allowlisted file, no `NEXT_PUBLIC_`-prefixed secret, every interactive
  element carries a visible focus ring, the RLS-bypassing admin client is
  imported only from an explicit, named allowlist, and (added across this
  history) every client-only cryptographic module (`zk-crypto.ts`,
  `dead-mans-switch-crypto.ts`, the local embedder, the receipt-OCR
  engine, the cash-flow forecaster) is provably never imported from
  server code.
- **CI (`.github/workflows/ci.yml` + `deploy-migrations.yml`)**: a
  typecheck/lint/full-test job against a real ephemeral Postgres, plus
  two independent, separately-reported security-scanning jobs —
  **Gitleaks** (pinned `v8.30.1`, the OSS CLI directly rather than a
  paid-license wrapper action, scanning the working tree) and **Semgrep**
  (pinned `semgrep/semgrep:1.174.0` container, the `p/security-audit`,
  `p/typescript`, `p/react`, `p/secrets`, and `p/owasp-top-ten` public
  rulesets, `--error` so a real finding fails the job). Both scanners
  already caught and closed real findings in this project's own history:
  Semgrep flagged mutable `actions/checkout@v4`-style tags (fixed by
  pinning to full commit SHAs) and the two GCM-tag-length gaps closed in
  §4.1; a GitHub-Actions shell-injection vulnerability in the
  migration-deploy workflow's confirmation-input handling was found and
  fixed *before* it was ever merged.
- **A real, separately-gated production-migration path**
  (`deploy-migrations.yml`): `workflow_dispatch`-only, scoped to a
  GitHub Environment that (once an operator configures required
  reviewers, a one-time repository-settings step, not a code change) can
  withhold the job's start — and, specifically, its access to an
  environment-scoped `PRODUCTION_DATABASE_URL` secret — until approved.
  A repository-level secret would not get this protection; only an
  environment-scoped one does, which is the detail that makes this a
  real gate rather than a YAML file that merely resembles one. Notably,
  this session's history includes a deliberate, *rejected* design: a
  Web-Serial/Arduino hardware-key "gate" for this same endpoint was
  proposed, analyzed, and turned down — a client-side hardware check
  adds no real protection over the endpoint itself being properly
  authorized (the JS is readable; the underlying route is callable
  directly), while adding a real new failure mode (a lost USB dongle
  blocking every future migration). The environment-approval gate above
  is what was actually built instead.
- **This session's own verification, for the four items it added**: the
  full `npm run check` (typecheck + lint + test) was re-run clean after
  every change in this pass; Gitleaks and Semgrep were both re-run
  locally (the same pinned versions CI uses) against the complete
  changed tree before considering any of this work done, with zero new
  findings attributable to this session's changes — see §10 for the
  handful of pre-existing findings that remain, all outside this
  session's own changes.

---

## 9. Known risk boundaries and accepted risk

Stated plainly, not buried — a security report that only lists
mitigations without naming what's still open is not a complete report.

- **This is a Tier 2 system with mock data only.** No control in this
  report has been exercised against a real financial institution
  integration, a real production traffic pattern, or a real attacker.
- **No MFA of any kind.** A compromised password is a full account
  compromise. Argon2id makes offline cracking of a stolen hash
  expensive, but does not substitute for a second factor.
- **No password-reset flow.** A locked-out user has no self-service
  recovery path today — an accepted, honestly-stated cost of shipping
  Credentials-only auth in an environment with no outbound email
  infrastructure to build a reset flow against.
- **JWT sessions cannot be server-side revoked mid-lifetime.** There is
  no session table to delete a row from; a stolen valid JWT remains
  valid until it expires. A future move to database-backed sessions
  would need `@auth/prisma-adapter` compatibility with this project's
  Prisma 7 TS-source generator to be verified first (not yet done).
- **Two known, currently-accepted `npm audit` exception classes**: a pair
  of moderate `qs` advisories transitive through a `devDependency`
  (Stryker mutation testing) never bundled into the production build;
  and several high-severity advisories transitive through
  `@huggingface/transformers`'s optional Node-backend dependencies
  (`onnxruntime-node`, `sharp`), which this app's actual browser-WASM
  code path never reaches (enforced by the same client-only import
  guard discussed in §8). Both documented at the point they were found,
  re-checked, not silently ignored.
- **The Emergency Vault's beneficiary-recovery and legacy-note-migration
  paths are the only places server-side plaintext exposure is
  architecturally unavoidable** (§4.2) — narrowly scoped, individually
  documented, never logged or persisted, but real, and worth an explicit
  line here rather than only in the source comment.
- **No EIP-55 checksum validation existed before this session** (§4.4,
  now closed) and **no dividend income was included in the German tax
  simulator's Kapitalerträge base before this session** (a correctness
  gap in a financial simulator, not a security one, but worth naming for
  completeness) — both closed in this pass; recorded here as evidence
  that this report reflects what changed, not a static claim.
- **`docs/SECURITY.md` and `docs/SECURITY-CHECKLIST.md` need a refresh
  pass** to bring their per-control status markers back in sync with
  what has actually shipped since Phase 7 (see this report's header) —
  named here explicitly so it isn't lost.
- **No formal penetration test, third-party audit, or bug bounty has
  been run against this system.** Every verification claim in this
  report was performed by this project's own engineering process (its
  own test suite, its own live `curl`/browser verification, its own CI
  scanners) — a real, meaningful bar, but not a substitute for
  independent adversarial review before any Tier 3 decision.

---

## 10. Current dependency-scanner findings (informational, not a gate)

As of this report, a full local Gitleaks + Semgrep run (the same pinned
versions CI uses) against the complete working tree returns:

- **Gitleaks**: findings only inside the gitignored `.next/` build-output
  directory (Next.js's own internal preview-mode signing/encryption
  keys, regenerated every build, never committed — confirmed via
  `git check-ignore`). Zero findings in tracked source.
- **Semgrep**: 4 findings, all in files this session did not touch
  (`src/lib/text-matching.ts`, `src/server/advisor/tools.ts`,
  `src/server/env.test.ts`) — a non-literal-RegExp construction pattern
  (ReDoS-audit heuristic; these regexes are built from fixed, small,
  developer-controlled inputs, not user-controlled ones, so the
  practical risk is low, but not yet re-triaged/suppressed with an
  inline justification) and a template-string argument to
  `console.error`. Pre-existing, not introduced by any change in this
  report; flagged for a future triage pass rather than silently
  omitted here.

---

## 11. Verification methodology

Every non-trivial claim above was checked at least one of these ways,
consistent with this project's standing engineering discipline of
"verify live, don't just write it down":

1. **A real automated test** in `npm run test` (currently 1,000+ tests
   across unit, component, and integration projects — the integration
   tier runs against a real, ephemeral Postgres with RLS genuinely
   enabled, not a mock).
2. **A real e2e/browser check** (`npm run test:e2e`, Playwright against a
   real production build) for anything a jsdom-level test structurally
   cannot prove — real Tab order, real computed CSS contrast, real HTTP
   response headers.
3. **A real live `curl`/browser walkthrough** against a running dev or
   production-mode server, for request/response shapes and status codes
   a unit test's mocked boundary can't exercise end to end.
4. **Direct execution of a claim about a third-party library's actual
   behavior** (this session's own EIP-55/`viem` finding is a concrete
   example) rather than trusting documentation or a plausible-sounding
   assumption.

This report itself was produced the same way: every control named above
either points at a specific file/test that can be re-run, or is stated as
an explicit, named gap in §9 rather than glossed over.
