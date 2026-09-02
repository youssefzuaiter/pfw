# PFW Security & Threat Model

Status: originally drafted in Phase 0, revisited at the end of every phase
that introduced new attack surface. Most recently refreshed to reflect real
authentication landing (AGENTS.md §3ff — Auth.js Credentials + Argon2id —
and §3hh — TOTP MFA + server-side JWT revocation via `tokenVersion`),
replacing this document's original "no real auth exists yet" framing
wherever it appeared (see §2's Session identifiers row and §3.1's Auth
endpoints entry below).
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
| **Tier 2 (current)** | Synthetic/mock Israeli banking data, deterministically seeded. No real PII, no real account credentials, no real balances. | Public deployment allowed (e.g. Vercel preview/prod) for demo purposes. | Real multi-user authentication (Auth.js Credentials, Argon2id, optional TOTP MFA — AGENTS.md §3ff/§3hh), ASVS L1 baseline + L2 on auth/session/access-control primitives. |
| **Tier 3 (future)** | Real linked bank data (via CSV import or future Open Banking/Israeli "Open Finance" API), real balances, real identity. | Restricted deployment, requires DPA/PIA. | Full multi-user auth: WebAuthn primary, TOTP+recovery codes secondary, Argon2id fallback, mandatory MFA step-up on sensitive actions. |

The **only** things that should need to change between Tier 2 → Tier 3:
- Real user registration is already live (§3ff) — Tier 3 would tighten it: email verification on registration, a self-service password-reset flow, and a login-brute-force lockout beyond the existing per-email rate limit on `/api/auth/register`, none of which exist yet (see `docs/SECURITY-CHECKLIST.md` V2/V3's notes for the full current gap list).
- Point CSV import adapters at real statements (same adapter interface, same Zod validation, same formula-injection guard).
- Tighten rate limits / enable step-up MFA policy flags (TOTP MFA itself already exists per-user, §3hh — this would be making it mandatory rather than opt-in).
- Harden session cookie posture: `__Host-`-prefixed name, `SameSite=Strict`, a short JWT TTL (currently Auth.js's untouched defaults — see `docs/SECURITY-CHECKLIST.md` item 13).
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
| Session identifiers | Yes | Signed JWT (Auth.js, `session: { strategy: "jwt" }`) | `src/server/auth/current-user.ts`'s `getCurrentUser()` contract is unchanged from the original design (always resolves a real `User` row server-side, never trusts a client-supplied id) — only its internals changed, from a hardcoded seeded email to a real session read. The JWT carries only `id`/`tokenVersion`, no other claims; server-side revocation is real despite the stateless-JWT format (`tokenVersion` re-checked every request — AGENTS.md §3hh, `docs/SECURITY-CHECKLIST.md` item 12). Cookie posture is Auth.js's untouched default (`HttpOnly`+`Secure` yes, not `__Host-`-prefixed, `SameSite=Lax` not `Strict` — item 13's documented gap). |
| Password hash | Yes | Argon2id, salted | `src/server/auth/credentials.ts` (`argon2` package, Argon2id — the library's default mode). No bcrypt fallback exists or is needed; every real password in this app has been Argon2id from the start. |
| TOTP MFA secret | Yes (opt-in) | AES-256-GCM encrypted at rest, same codec as row below | `User.totpSecret` — only present for a user who has enabled MFA (AGENTS.md §3hh); `totpEnabled` only flips true once setup is proven with a real working code, never at mere secret-generation time. |
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
- **Auth endpoints** (`/login`, `/register`, `POST /api/auth/register`, Auth.js's own `/api/auth/*` handlers) — real and live (AGENTS.md §3ff), classic user-enumeration and credential-stuffing targets. `verifyCredentials` returns an identical `null` for all three failure shapes (unknown email, unclaimed row, wrong password), so login can't be used to enumerate accounts; `POST /api/auth/register` rate-limits by the submitted email plus a coarser global limit. **Not yet built**: email verification, self-service password reset, and a dedicated login-brute-force lockout beyond that per-email registration limit — see `docs/SECURITY-CHECKLIST.md` V2/V3 for the itemized status.

### 3.2 Client / browser surface
- **XSS via merchant/description strings rendered in the UI** — these are user- or CSV-supplied strings, never treated as trusted HTML. No `dangerouslySetInnerHTML` anywhere (enforced by a Phase 1 guard test).
- **CSP bypass** — mitigated by per-request nonce, `object-src 'none'`, `frame-ancestors 'none'`, no `unsafe-inline`/`unsafe-eval`.
- **Secret leakage into client bundle** — mitigated by React Taint API (`experimental_taintUniqueValue`) on env vars/secret objects, plus a CI grep step for stray `NEXT_PUBLIC_`-prefixed secrets.
- **Clickjacking** — `frame-ancestors 'none'` + `X-Frame-Options` equivalent via CSP.

### 3.3 CSV import surface — **built**

Implemented as `src/lib/csv-import/` (pure parsing pipeline),
`src/server/dal/transaction-import.ts` (deduplicating writer), and
`POST /api/transactions/import` (upload route), with the upload UI on
`/transactions`. Every control below is live and covered by tests
(`src/lib/csv-import/*.test.ts`, 78 cases) plus hand-verification against
a real upload — see AGENTS.md §3j.

- **Formula injection** — a merchant/description cell beginning with `=`, `+`, `-`, `@`, TAB, or CR is neutralized with a single-quote prefix on ingest (`src/lib/csv-import/formula-injection.ts`). Applied to free-text fields **only**, never to amount or date cells: a legitimate debit is written `-125.50`, so a blanket "sanitize every cell" pass would corrupt every expense in the file into an unparseable `'-125.50`. That constraint has its own regression test rather than living only in a comment.
- **Malformed/oversized files** — rejected in layers before any interpretation: a byte ceiling checked against `File.size` *before* the body is buffered, then a 2 MB decode ceiling, a 5,000-row ceiling, a 500-character-per-cell ceiling, an extension check, and a MIME allowlist. Unterminated quotes and empty files are hard errors; a single malformed *row* is a non-fatal per-row error so one bad line doesn't cost the user the rest of the statement.
- **Duplicate replay** — `NotableTransaction`'s `@@unique([userId, providerTransactionId])` is the enforcement point, fed by the bank's own reference where the export supplies one and a SHA-256 content hash where it doesn't. The content-hash fallback is **mandatory, not a nicety**: Postgres does not treat NULLs as equal in a unique index, so rows left with a `null` provider id would re-import as full duplicates on every upload with no constraint violation at all — a silent balance-inflation bug. Verified live: importing the same file twice yields `importedCount: 0, duplicateCount: 6` on the second run.
- **Adapter-specific parsing bugs** — isolated per institution (architectural decision #4). Each adapter declares only its column aliases, date format, and sign convention; all parsing logic is shared and tested once. Notably, the date format and sign convention are **declared, never sniffed** — `03/04/2026` is a valid date under both DD/MM and MM/DD and means two different days, and guessing a credit-card statement's sign convention would invert every amount in the file.
- **Currency** — a row carrying a non-shekel currency is refused outright rather than imported at face value, which would corrupt the ledger by roughly the FX rate. This app is single-currency by law (spec Section 1) and has no conversion model to fall back on.

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
    | HTTPS, CSP nonce, HttpOnly+Secure session JWT cookie (Auth.js default
    | naming/SameSite -- not yet __Host-/Strict, see SECURITY-CHECKLIST item 13)
    v
[ Next.js proxy.ts ]  -- generates CSP nonce, security headers, Origin/Host allowlist
    |                     check, AND the real auth gate (redirect to /login / 401 JSON)
    v
[ Route Handlers / Server Actions ]  -- Zod validation, getCurrentUser() -> real
    |                                    Auth.js session -> userId resolution
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

Side channel (built — see §3.3):
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
