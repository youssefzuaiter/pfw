import "server-only";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { getAuthSecret } from "../env";
import { verifyCredentials } from "./credentials";

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
  // (k8s/app/ingress.yaml). Auth.js's own installed-package doc comment
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
      },
      async authorize(credentials) {
        const email = credentials?.email;
        const password = credentials?.password;
        if (typeof email !== "string" || typeof password !== "string") return null;

        const user = await verifyCredentials(email, password);
        if (!user) return null;

        return { id: user.id, email: user.email, name: user.displayName };
      },
    }),
  ],
  callbacks: {
    // The JWT only ever carries the user id — never re-derive display
    // data from it; every real page/route still calls getCurrentUser(),
    // which reads the CURRENT row from the database, so a changed
    // displayName/email is never stale behind an old token.
    jwt({ token, user }) {
      if (user) token.id = user.id;
      return token;
    },
    session({ session, token }) {
      if (session.user) session.user.id = token.id as string;
      return session;
    },
  },
});
