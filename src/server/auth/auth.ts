import "server-only";
import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { getAuthSecret } from "../env";
import { checkTotpChallenge, verifyCredentials } from "./credentials";
import { getCurrentTokenVersion } from "./token-version";

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
  session: { strategy: "jwt" },
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

        const user = await verifyCredentials(email, password);
        if (!user) return null;

        const totpCode = typeof credentials?.totpCode === "string" ? credentials.totpCode : undefined;
        const totpResult = await checkTotpChallenge(user.id, totpCode);
        if (totpResult === "required") throw new TotpRequiredError();
        if (totpResult === "invalid") throw new TotpInvalidError();
        // "not_required" (MFA never enabled) or "valid" (code confirmed)
        // both fall through to a normal successful sign-in.

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
