import "server-only";
import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import type { AuthenticationResponseJSON, AuthenticatorDevice } from "@simplewebauthn/types";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { getAppUrl, getAuthSecret } from "../env";
import { checkLoginRateLimit, checkTotpChallenge, verifyCredentials } from "./credentials";
import { getCurrentTokenVersion } from "./token-version";
import { recordFailedLoginAttempt, resetFailedLoginAttempts } from "./account-lockout";
import { adminFindUserByEmail } from "./account-recovery-admin-ops";
import { adminFindUnusedRecoveryCode, adminMarkRecoveryCodeUsed } from "./recovery-code-admin-ops";
import { hashRecoveryCode } from "./recovery-codes";
import {
  consumeAuthenticationChallenge,
  findAuthenticationCandidate,
  findAuthenticatorForVerification,
  recordSuccessfulAuthentication,
} from "./webauthn-admin-ops";
import { base64UrlToUint8Array, getRelyingParty } from "./webauthn";

/**
 * TOTP MFA (Punch List Tier 2, item 3) — two distinct `CredentialsSignin`
 * subclasses, not one generic error, because the client needs to tell them
 * apart: "required" means "show the code field," "invalid" means "that
 * code was wrong, let them retry." Both are thrown only AFTER
 * `verifyCredentials` already confirmed the password (see
 * `credentials.ts`'s `checkTotpChallenge` doc comment for why that
 * ordering matters) — subclassing `CredentialsSignin` and setting `code`
 * is the officially documented way to surface a specific reason from
 * `authorize()`; verified directly against the installed `@auth/core`
 * source (`errors.js`/`index.js`) that this `code` is what actually
 * reaches the client via `next-auth/react`'s `signIn(..., {redirect:
 * false})` result (`result.code`), not assumed from the beta docs alone —
 * the same "check the real installed API before relying on it" discipline
 * this app's history already applies elsewhere (onnxruntime-web variants,
 * the otplib v13 rewrite).
 */
class TotpRequiredError extends CredentialsSignin {
  code = "totp_required";
}
class TotpInvalidError extends CredentialsSignin {
  code = "totp_invalid";
}
/** Login-lockout (auth hardening pass, ad hoc post-§3ff) — see `credentials.ts`'s `checkLoginRateLimit` doc comment. */
class LoginRateLimitedError extends CredentialsSignin {
  code = "too_many_attempts";
}
/** Account lockout (Phase 3, Security & Recovery) — see `User.accountLockedAt`'s own schema doc comment and `account-lockout.ts`. Distinct from `LoginRateLimitedError`: that one self-resets after its time window; this one persists until a recovery code or password reset explicitly clears it. */
class AccountLockedError extends CredentialsSignin {
  code = "account_locked";
}

/**
 * Auth.js v5 config (AGENTS.md §3ff) — Credentials provider (email +
 * Argon2id-hashed password, verified by src/server/auth/credentials.ts)
 * with JWT sessions, deliberately NOT the database-session strategy.
 * Two real reasons, not just simplicity:
 *   1. `@auth/prisma-adapter` is built against the standard
 *      `prisma-client-js` generated client shape; this app's generator
 *      is Prisma 7's newer `prisma-client` TS-source mode (AGENTS.md
 *      §3a), and this pass never verified the adapter actually supports
 *      that shape. JWT sessions need no adapter at all, sidestepping the
 *      question entirely rather than guessing at compatibility.
 *   2. AGENTS.md §5 decision #1's original bet was exactly this: "no
 *      Session table exists (or is needed) yet... nothing about the
 *      DAL/RLS shape needs to change when real auth lands — only
 *      getCurrentUser()'s internals do." JWT sessions keep that bet
 *      true; a DB-session strategy would have broken it by requiring
 *      new Session/Account/VerificationToken tables this pass never
 *      asked for.
 *
 * `secret` reads `getAuthSecret()` at MODULE LOAD, not lazily — a
 * deliberate, narrow exception to this app's usual "read every secret
 * lazily, one field at a time" rule (src/server/env.ts's own doc
 * comment explains why that rule exists). Next.js's route-handler
 * convention requires `handlers` to be a stable, eagerly-constructed
 * export (`export const { GET, POST } = handlers` in
 * src/app/api/auth/[...nextauth]/route.ts) — there's no way to defer
 * `NextAuth(...)`'s own construction the way every OTHER secret getter
 * in this app defers `process.env` access. Safe in practice because
 * `AUTH_SECRET` sits in the same "always required, every real
 * environment sets it" tier as `ANTHROPIC_API_KEY`/`ENCRYPTION_KEY`
 * already do (added to `.env.example` and `ci.yml`'s env block
 * alongside them) — the original Phase 2 bug this rule guards against
 * was specifically about a value that's legitimately ABSENT in some
 * environments (like `APP_DATABASE_URL` in a plain unit-test run);
 * `AUTH_SECRET` is never in that category.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: getAuthSecret(),
  // A real, verified production blocker this app's own Docker/k8s prep
  // pass (Punch List Phase 4) found by actually running the built
  // container behind a port-forward, not by reasoning about it in the
  // abstract: without `trustHost: true`, Auth.js rejects every request
  // with `UntrustedHost` the instant the incoming `Host` header isn't
  // one of a short list of platforms (Vercel etc.) it auto-recognizes as
  // safe — which is every self-hosted deployment behind a reverse proxy,
  // including the Kubernetes Ingress this app now ships
  // (future-infra/k8s/app/ingress.yaml). Auth.js's own installed-package doc comment
  // for this option says exactly what it needs and why: "Auth.js relies
  // on the incoming request's `host` header to function correctly. For
  // this reason this property needs to be set to `true` ... make sure
  // your deployment platform sets the `host` header safely." This
  // app's own `src/server/api/verify-origin.ts` (guardMutation's
  // Origin/Host CSRF check, Section 2.4) is the actual control already
  // protecting every mutating route against a forged Host/Origin —
  // `trustHost: true` doesn't remove that; it stops Auth.js from
  // independently re-litigating a Host header the reverse proxy in
  // front of it (the Ingress) is what's actually responsible for
  // presenting correctly.
  trustHost: true,
  // Auth hardening pass (ad hoc, post-§3ff) — a shorter session lifetime
  // than Auth.js's own 30-day default (`docs/SECURITY-CHECKLIST.md` item
  // 13 flagged this gap explicitly): 7 days, refreshed once a day of
  // activity (`updateAge`) so an actively-used session doesn't
  // unexpectedly expire mid-week while an abandoned one still does stop
  // being valid within a bounded window.
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
  // Cookie hardening (`docs/SECURITY-CHECKLIST.md` item 13's other two
  // gaps: not `__Host`-prefixed, `SameSite=Lax` not `Strict`) —
  // deliberately gated on `APP_URL` actually being an `https://` origin,
  // NOT on `NODE_ENV === "production"` (a real bug this pass's own e2e
  // work caught: `next start` unconditionally sets `NODE_ENV=production`
  // internally, even when serving plain HTTP with no TLS in front of it
  // — e.g. this app's own Playwright e2e suite, which runs `next build
  // && next start` on `http://localhost:3100`. Gating on `NODE_ENV`
  // alone would have applied `Secure`/`__Host-` to a cookie set over a
  // connection that was never actually HTTPS, silently breaking sign-in
  // for anyone running `next start` without an HTTPS-terminating proxy
  // in front of it — caught by the e2e login flow failing, not assumed).
  // `getAppUrl()` is this app's own operator-set signal for its real
  // public origin (added this same pass, for building email links) —
  // checking its protocol mirrors Auth.js's OWN default cookie logic
  // (`defaultCookies()`, `useSecureCookies = url.protocol === "https:"`,
  // verified directly against the installed `@auth/core` source rather
  // than assumed) using a value this static config block can actually
  // see (a per-request URL isn't available here). `SameSite: "strict"`
  // is a real, accepted trade-off: a link to this app clicked FROM an
  // external site (an email client, a bookmark-sharing tool) won't carry
  // the session cookie on that very first cross-site-initiated
  // navigation, reading as logged-out until the next same-site request —
  // acceptable here since this app never emails a link to a page that
  // itself requires an existing session (the reset/verify links land on
  // dedicated public pages, `src/proxy.ts`'s own allowlist).
  ...(getAppUrl().startsWith("https://")
    ? {
        cookies: {
          sessionToken: {
            name: "__Host-authjs.session-token",
            options: {
              httpOnly: true,
              sameSite: "strict" as const,
              path: "/",
              secure: true,
              maxAge: 60 * 60 * 24 * 7,
            },
          },
        },
      }
    : {}),
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        // Optional — the LoginForm only sends this on a second submission,
        // once the first one came back with the "totp_required" code
        // (Punch List Tier 2, item 3). Absent for every account that
        // hasn't enabled MFA, and for the first submission of every login.
        totpCode: { label: "Authentication code", type: "text" },
      },
      async authorize(credentials) {
        const email = credentials?.email;
        const password = credentials?.password;
        if (typeof email !== "string" || typeof password !== "string") return null;

        if (!checkLoginRateLimit(email)) throw new LoginRateLimitedError();

        const verification = await verifyCredentials(email, password);
        if (verification.outcome === "locked") throw new AccountLockedError();
        if (verification.outcome === "invalid") return null;
        const user = verification.user;

        const totpCode = typeof credentials?.totpCode === "string" ? credentials.totpCode : undefined;
        const totpResult = await checkTotpChallenge(user.id, totpCode);
        if (totpResult === "required") throw new TotpRequiredError();
        if (totpResult === "invalid") {
          // A wrong TOTP code AFTER a correct password is still a failed
          // authentication (account-lockout.ts's own doc comment) —
          // checked here, not inside checkTotpChallenge itself, so
          // credentials.ts's single-responsibility check functions stay
          // focused on their own factor and auth.ts (the orchestrator)
          // owns cross-provider lockout bookkeeping consistently.
          const justLocked = await recordFailedLoginAttempt(user.id);
          if (justLocked) throw new AccountLockedError();
          throw new TotpInvalidError();
        }
        // "not_required" (MFA never enabled) or "valid" (code confirmed)
        // both fall through to a normal successful sign-in.
        await resetFailedLoginAttempts(user.id);

        return { id: user.id, email: user.email, name: user.displayName, tokenVersion: user.tokenVersion };
      },
    }),
    /**
     * Device-Bound Biometrics via Passkeys (ad hoc) — a SECOND
     * Credentials provider, not Auth.js's own built-in `WebAuthn`
     * provider (see `webauthn.ts`'s doc comment for why: the official
     * provider requires a database Adapter this app deliberately
     * doesn't have, plus a new `Account`-shaped table). This provider's
     * `authorize()` does the actual `@simplewebauthn/server` verification
     * itself — the client has ALREADY completed the real WebAuthn
     * ceremony (`navigator.credentials.get()`, via
     * `@simplewebauthn/browser`'s `startAuthentication()`) against a
     * challenge issued by `POST /api/auth/webauthn/authenticate-options`
     * before ever calling `signIn("passkey", ...)` — this function only
     * verifies the resulting signed assertion, exactly mirroring how the
     * `credentials` provider above verifies a password (and how
     * `checkTotpChallenge` verifies a TOTP code) inside `authorize()`
     * rather than in a separate route.
     *
     * Rate-limited via the SAME `checkLoginRateLimit` bucket password
     * login uses (keyed by email) — a deliberate choice, not an
     * oversight: bounding total authentication attempts against one
     * target account regardless of which method is being tried is more
     * defensible than two independent, individually-generous budgets an
     * attacker could exhaust separately.
     *
     * Every failure path returns `null` (never a distinguishing error) —
     * unlike TOTP's required/invalid split, there is no legitimate
     * "second step" here: a passkey assertion either verifies in one
     * shot or the attempt failed, so there's nothing to tell the client
     * to retry differently the way "enter your code" is.
     */
    Credentials({
      id: "passkey",
      name: "Passkey",
      credentials: {
        email: { label: "Email", type: "email" },
        challengeId: { label: "Challenge ID", type: "text" },
        assertion: { label: "Assertion", type: "text" },
      },
      async authorize(credentials) {
        const email = credentials?.email;
        const challengeId = credentials?.challengeId;
        const assertionJson = credentials?.assertion;
        if (typeof email !== "string" || typeof challengeId !== "string" || typeof assertionJson !== "string") {
          return null;
        }

        if (!checkLoginRateLimit(email)) throw new LoginRateLimitedError();

        const candidate = await findAuthenticationCandidate(email);
        if (!candidate) return null;
        if (candidate.accountLockedAt) throw new AccountLockedError();

        const expectedChallenge = await consumeAuthenticationChallenge(candidate.userId, challengeId);
        if (!expectedChallenge) return null;

        let assertion: AuthenticationResponseJSON;
        try {
          assertion = JSON.parse(assertionJson);
        } catch {
          return null;
        }
        if (typeof assertion.id !== "string") return null;

        const stored = await findAuthenticatorForVerification(candidate.userId, assertion.id);
        if (!stored) return null;

        const rp = getRelyingParty();
        let result;
        try {
          result = await verifyAuthenticationResponse({
            response: assertion,
            expectedChallenge,
            expectedOrigin: rp.origin,
            expectedRPID: rp.id,
            authenticator: {
              credentialID: base64UrlToUint8Array(assertion.id),
              credentialPublicKey: stored.publicKey,
              counter: Number(stored.counter),
              transports: stored.transports as AuthenticatorDevice["transports"],
            },
          });
        } catch {
          return null;
        }
        if (!result.verified) {
          // Only the FINAL cryptographic verification failure counts as a
          // failed authentication for lockout purposes — an expired/
          // consumed challenge or an unrecognized credential id (both
          // handled above with a plain `null`) are protocol-level
          // rejections, not a genuinely attempted-and-rejected biometric
          // check, so they're deliberately not counted here.
          const justLocked = await recordFailedLoginAttempt(candidate.userId);
          if (justLocked) throw new AccountLockedError();
          return null;
        }

        await recordSuccessfulAuthentication(stored.id, BigInt(result.authenticationInfo.newCounter));
        await resetFailedLoginAttempts(candidate.userId);

        return { id: candidate.userId, email: candidate.email, name: candidate.displayName, tokenVersion: candidate.tokenVersion };
      },
    }),
    /**
     * MFA backup-code emergency bypass (Phase 3, Security & Recovery) —
     * a THIRD Credentials provider, deliberately NOT a hand-rolled route
     * that manually mints a session cookie itself. "Issues the session
     * JWT" is exactly what Auth.js's own `jwt()`/`session()` callbacks
     * below already do, correctly, for every other sign-in path
     * (tokenVersion stamping, the `__Host-`/`SameSite=Strict` cookie
     * hardening, the 7-day session lifetime) — reimplementing that by
     * hand here would duplicate already-hardened logic and risk getting
     * one of those details wrong a second time. The actual "emergency
     * bypass" application logic (verify the code's hash, mark it used,
     * unlock the account) lives entirely in this function's own body,
     * reached via Auth.js's existing `/api/auth/callback/recovery-code`
     * route — the same shape decision this app already made once for
     * the "passkey" provider above, after investigating and rejecting a
     * more literal-sounding alternative (see `webauthn.ts`'s own doc
     * comment for that precedent).
     *
     * Deliberately bypasses BOTH password and TOTP entirely — that's the
     * feature's whole point (a lost authenticator device or forgotten
     * password) — and, per this phase's explicit requirement, is one of
     * the only two ways to clear a real account lock (the other is a
     * completed password reset, `confirmPasswordReset`).
     */
    Credentials({
      id: "recovery-code",
      name: "Recovery code",
      credentials: {
        email: { label: "Email", type: "email" },
        code: { label: "Recovery code", type: "text" },
      },
      async authorize(credentials) {
        const email = credentials?.email;
        const code = credentials?.code;
        if (typeof email !== "string" || typeof code !== "string") return null;

        if (!checkLoginRateLimit(email)) throw new LoginRateLimitedError();

        const user = await adminFindUserByEmail(email);
        if (!user) return null;

        const codeHash = hashRecoveryCode(code);
        const record = await adminFindUnusedRecoveryCode(user.id, codeHash);
        if (!record) {
          // A wrong/already-used code is still a failed authentication
          // attempt (account-lockout.ts's own doc comment) — but never
          // throws AccountLockedError here even if it crosses the
          // threshold: a user reaching for their recovery codes already
          // knows the account is in trouble, and this provider's entire
          // purpose is to stay usable regardless of lock state (see the
          // early-return check its OWN success path never adds one for,
          // below), so telling them "also, now locked" would be noise,
          // not new information.
          await recordFailedLoginAttempt(user.id);
          return null;
        }

        await adminMarkRecoveryCodeUsed(record.id);
        await resetFailedLoginAttempts(user.id);

        return { id: user.id, email: user.email, name: user.displayName, tokenVersion: user.tokenVersion };
      },
    }),
  ],
  callbacks: {
    // The JWT only ever carries the user id (+ tokenVersion, below) —
    // never re-derive display data from it; every real page/route still
    // calls getCurrentUser(), which reads the CURRENT row from the
    // database, so a changed displayName/email is never stale behind an
    // old token.
    async jwt({ token, user }) {
      if (user) {
        // Fresh sign-in — `user` is exactly what `authorize()` returned
        // above, tokenVersion included (src/types/next-auth.d.ts). The
        // `?? 1` fallback should never actually trigger (verifyCredentials
        // always reads a real stored value, defaulted to 1 by the schema
        // itself), but matches that same starting convention rather than
        // an inconsistent magic 0 if it ever did.
        token.id = user.id;
        token.tokenVersion = user.tokenVersion ?? 1;
        return token;
      }

      if (typeof token.id !== "string") return null;

      // Server-side JWT revocation (Punch List Tier 2, item 2): re-check
      // the CURRENT tokenVersion stored for this user on every request
      // that isn't a fresh sign-in. A mismatch means
      // src/server/auth/token-version.ts's bumpTokenVersion() ran since
      // THIS specific token was issued (the "Sign out of all sessions"
      // settings action, or disabling TOTP MFA) — returning `null` here
      // is what actually invalidates the session for JWT-strategy
      // sessions: verified directly against the installed
      // `@auth/core/lib/actions/session.js` (not assumed from docs) that
      // when `jwt()` returns `null`, the session cookie is cleared
      // instead of re-signed, and the response body stays `null`.
      //
      // Real, deliberate one-time transition effect, not a bug: every
      // session that was already valid BEFORE this feature shipped
      // carries no tokenVersion at all (`token.tokenVersion === undefined`,
      // which never strictly matches a real stored integer), so every
      // pre-existing session is invalidated the first time this runs
      // post-deploy — a one-time hard cutover, not a recurring cost.
      const currentVersion = await getCurrentTokenVersion(token.id);
      if (currentVersion === null || currentVersion !== token.tokenVersion) {
        return null;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) session.user.id = token.id as string;
      return session;
    },
  },
});
