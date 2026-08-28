# PFW Security & Threat Model

Status: current as of Phase 7 (Verification, Accessibility & Security Audit) —
originally drafted in Phase 0, revisited at the end of every phase that
introduced new attack surface, most recently to reflect what actually shipped
vs. what was deferred (see §3.3 and §2 below).
Owner: engineering (single-maintainer project)
Scope: this document is narrative (threat model, attack surfaces, data map). The
itemized OWASP ASVS control matrix, including Phase 7's audit findings and
`npm audit` results, lives in `docs/SECURITY-CHECKLIST.md` (produced in
Phase 1, updated every phase since). A formal point-in-time
`docs/SECURITY-REPORT.md` — the spec's Phase 8 deliverable — has not been
produced yet; `docs/SECURITY-CHECKLIST.md`'s "Phase 7 addendum" and
"Dependency audit" sections are the closest current equivalent.

---

## 1. Threat Model Tier

PFW is designed against two tiers. **We build Tier 2 now.** Every control below
is written so that moving to Tier 3 is a configuration/credential change, not a
schema or architecture change.

| Tier | Data sensitivity | Deployment | Auth strength required |
|---|---|---|---|
| **Tier 2 (current)** | Synthetic/mock Israeli banking data, deterministically seeded. No real PII, no real account credentials, no real balances. | Public deployment allowed (e.g. Vercel preview/prod) for demo purposes. | Session-based single-user model, ASVS L1 baseline + L2 on auth/session/access-control primitives even though there's one user, so the primitives are already load-bearing. |
| **Tier 3 (future)** | Real linked bank data (via CSV import or future Open Banking/Israeli "Open Finance" API), real balances, real identity. | Restricted deployment, requires DPA/PIA. | Full multi-user auth: WebAuthn primary, TOTP+recovery codes secondary, Argon2id fallback, mandatory MFA step-up on sensitive actions. |

The **only** things that should need to change between Tier 2 → Tier 3:
- Turn on real user registration (the auth tables/flows exist from Phase 1-2 onward, just gated behind a single seeded user in Tier 2).
- Point CSV import adapters at real statements (same adapter interface, same Zod validation, same formula-injection guard).
- Tighten rate limits / enable step-up MFA policy flags.
- Add a DPIA/PIA writeup and breach-notification runbook (process doc, not code).

No re-architecture: RLS policies, DAL scoping, encryption columns, audit log, and CSP/headers are already Tier-3-grade from day one.

---

## 2. Data Inventory & Minimization

| Data category | Stored? | Form stored | Notes |
|---|---|---|---|
| Bank login credentials (password/PIN/OTP) | **Never** | — | Ingestion is offline CSV import only. There is no bank login flow to phish or leak. |
| Full account number / card PAN | **Never** | — | Only last 4 digits + institution name (`BankAccount.last4`, `institutionName`). |
| National ID / date of birth | **Never** | — | Not collected; not needed for any feature. |
| Transaction ledger (amount, date, merchant, description) | Yes | Integer agorot, plaintext merchant/description | Merchant/description are the primary indirect-prompt-injection surface (Section 6) and Hebrew-boundary-safety surface. |
| Category rules / user corrections | Yes | Plaintext | Feeds Tier 1/Tier 3 of the categorization cascade. |
| Merchant embeddings | Yes | 384-dim float vector, shared/anonymized cache | No PII beyond the merchant string itself, which is already low-sensitivity (a shop name, not a person). |
| Portfolio holdings / trades | Yes | Integer agorot + share counts | Simulated only — no real brokerage linkage, no real money at risk. |
| Session identifiers | **Not built yet** | — | No real login flow exists — every request resolves to a single seeded demo user server-side (`src/server/auth/current-user.ts`), by design (AGENTS.md decision #1: auth-*shaped* plumbing — DAL/RLS `userId` scoping — ships now; real credentials/sessions are a later milestone). When built: opaque server-side session ID, `__Host-` cookie, no JWT with embedded claims. |
| Password hash (Tier 3) | Future | Argon2id, salted | bcrypt fallback only for migration compatibility, never as the primary scheme. |
| Sensitive metadata requiring field-level encryption | Yes | AES-256-GCM via Prisma extension | Candidates: institution name field, any freeform notes fields, recovery codes (hashed, not merely encrypted). |
| Audit log (who/what/when/before/after) | Yes | Append-only, integer deltas | Never contains secrets; references entity IDs and integer values only. |

**Minimization principle applied:** if a field isn't required by a screen or an
engine listed in the spec, it doesn't get a column. No freeform "notes" field
gets added speculatively; no address/phone/national-ID field exists anywhere
in the 15-model schema (14 domain models + the append-only `AuditLog`).

---

## 3. Attack Surfaces

### 3.1 Public HTTP surface
- **~17 API routes / server actions** — every state-changing route is a potential IDOR, mass-assignment, or replay target. Mitigations: DAL-enforced `userId` scoping, Zod at every boundary, `Idempotency-Key` on mutations, architectural test banning direct Prisma imports in route files.
- **`/api/advisor`** — the highest-value target: an LLM endpoint with tool access to the user's full financial ledger. Treated as its own threat zone (Section 3.4).
- **CSV import endpoint** — untrusted file upload; treated as its own threat zone (Section 3.3).
- **Auth endpoints (Tier 3)** — login/register/reset don't exist yet (no real auth ships until a later milestone — see the Session identifiers row in §2); they're classic user-enumeration and credential-stuffing targets, so timing-safe/identical-response design is a requirement *when they're built*, tracked as ⬜ in `docs/SECURITY-CHECKLIST.md` items 6-10, not something already shipped.

### 3.2 Client / browser surface
- **XSS via merchant/description strings rendered in the UI** — these are user- or CSV-supplied strings, never treated as trusted HTML. No `dangerouslySetInnerHTML` anywhere (enforced by a Phase 1 guard test).
- **CSP bypass** — mitigated by per-request nonce, `object-src 'none'`, `frame-ancestors 'none'`, no `unsafe-inline`/`unsafe-eval`.
- **Secret leakage into client bundle** — mitigated by React Taint API (`experimental_taintUniqueValue`) on env vars/secret objects, plus a CI grep step for stray `NEXT_PUBLIC_`-prefixed secrets.
- **Clickjacking** — `frame-ancestors 'none'` + `X-Frame-Options` equivalent via CSP.

### 3.3 CSV import surface — **planned architecture, not built**

Deliberately deferred (AGENTS.md §5, decision #4): `/transactions` shipped in
Phase 4 with search/filter/sort/recategorization only — exactly what that
phase's screen description asked for — and neither manual transaction entry
nor CSV import were part of it. Every point below is the *design* this
surface will follow if/when it's built, not a control that exists in the
codebase today; `docs/SECURITY-CHECKLIST.md` items 23/24 track this
explicitly as ⬜, and the current ingestion path is exclusively the
deterministic seed script (`prisma/seed/`), which never touches
user-supplied files.

- **Formula injection** — a merchant/description cell beginning with `=`, `+`, `-`, or `@` would be neutralized (single-quote prefix) both on ingest and on any re-export, so a poisoned statement couldn't execute a formula if the user later opened an exported CSV in a spreadsheet tool.
- **Malformed/oversized files** — would be rejected before parsing (size ceiling, MIME/extension check, row-count ceiling).
- **Duplicate replay** — provider-transaction-id (or content-hash fallback) upsert keys would prevent re-importing the same statement from inflating balances. (The upsert-key *mechanism* itself already exists and is exercised by the seed script — `NotableTransaction`'s `@@unique([userId, providerTransactionId])` — only the untrusted-file-upload entry point into it is missing.)
- **Adapter-specific parsing bugs** — would be isolated per bank adapter (Section: architectural decision #4) so a malformed Leumi export couldn't corrupt parsing of an Isracard export.

### 3.4 AI advisor surface (indirect prompt injection)
- **Untrusted content in the ledger** — a transaction description or merchant name is attacker-controllable in principle (anyone can name a merchant anything on a real statement). The system prompt explicitly delimits ledger records as *data*, never as instructions, using structural delimiters the model is told never to treat as commands.
- **Tool scope** — 10 read-only tools, each taking strictly typed inputs, each going through the same DAL scoping as every other data path (`userId` mandatory, never client-supplied). The model cannot execute SQL, run code, or write/mutate any record.
- **No chain-of-thought or tool-call leakage** — only final text deltas are streamed to the client.
- **Cost/DoS** — sliding-window rate limit on `/api/advisor`, a per-request token ceiling, and a hard budget cap set in the Anthropic Console as a backstop independent of application logic.

### 3.5 Database surface
- **Compromised app credential** — the app connects as a non-superuser role with a strict connection limit; RLS policies provide defense-in-depth even if the DAL scoping layer were ever bypassed by a bug.
- **Raw SQL injection** — `$queryRawUnsafe` is banned outright; any raw SQL use is tagged `$queryRaw` with typed parameters, and this is enforced as a lint/CI rule, not a convention.

---

## 4. Trust Boundaries (narrative boundary diagram)

```
[ Browser ]
    | HTTPS, CSP nonce, __Host- session cookie
    v
[ Next.js Middleware ]  -- generates CSP nonce, security headers, Origin/Host allowlist check
    |
    v
[ Route Handlers / Server Actions ]  -- Zod validation, session -> userId resolution
    |  (NEVER imports Prisma directly -- enforced by architectural test)
    v
[ Data Access Layer (DAL) / Repositories ]  -- every function requires userId, enforces where:{userId}
    |
    v
[ Prisma Client (least-privilege, non-superuser role) ]
    |
    v
[ PostgreSQL 17 (pfw_local) ]  -- RLS policies (defense-in-depth), AES-256-GCM on sensitive columns
    |
    +--> [ AuditLog ] (append-only, written alongside every mutation)

Side channel:
[ Route Handler: /api/advisor ] --> [ Anthropic API ] (server-side key only, never reaches client)
                                 --> [ 10 read-only tools ] --> DAL (same scoping as above)

Side channel (planned, not built — see §3.3):
[ CSV Import Route ] --> [ Bank Adapter (per-institution) ] --> [ Canonical row + Zod validation
                                                                   + formula-injection neutralization ]
                                                              --> DAL (idempotent upsert)

Side channel:
[ Merchant Embeddings ] --> [ FastAPI/ONNX sidecar, localhost-only ] --> 384-dim vector --> DAL cache
```

Every arrow crossing a boundary is a place where the receiving side re-validates rather than trusting the sender. In particular: the DAL never trusts that a route handler already checked ownership — it re-derives `userId` from the authenticated session on every call.

---

## 5. Non-Goals for Tier 2 (explicitly out of scope for now)

- Real bank credential ingestion or Open Banking API integration.
- Real brokerage order routing (trading desk is simulated only).
- Multi-tenant organization/team accounts.
- Regulatory-grade financial advice disclaimers/licensing (advisor is informational only, not licensed financial advice — a UI disclaimer is sufficient at this tier).

These are recorded here so a future Tier 3 push has an explicit list of what was deliberately deferred, rather than silently assumed.

---

## 6. Regulatory Note (Israel — Protection of Privacy Law, Amendment 13)

Even at Tier 2 with synthetic data, the schema and data-minimization plan above are designed to already satisfy Amendment 13's data-minimization and breach-readiness expectations for when Tier 3 introduces real personal financial data: no excess PII fields exist to retrofit-delete, and the append-only audit log doubles as the breach-forensics trail requirement. A formal registration/notification assessment is a Tier 3 legal task, not an engineering one, and is out of scope for this document.

---

*This document will be revisited at the end of every phase where new attack surface is introduced (data layer, API layer, AI advisor). The itemized ASVS control checklist and the final audit report are separate documents (see header).*
