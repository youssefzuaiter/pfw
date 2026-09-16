/**
 * The demo account's credentials — deliberately PUBLIC, not a secret
 * (ad hoc, trader integration hardening / demo-login repair).
 *
 * Two places need the same values and used to hold their own copies,
 * which is how the Demo Login button ended up unable to work at all: the
 * login form auto-submitted `demo@pfw.local`/`demopassword123`, while the
 * seed script created that row with NO password (so a first real
 * registration could claim it, §3ff) — and every re-seed silently kept
 * the two out of step. Now the seed hashes THIS password onto the demo
 * row whenever `NEXT_PUBLIC_DEMO_MODE=true` (see `prisma/seed/index.ts`),
 * and the button submits THIS password, so there is one definition to
 * drift from.
 *
 * Lives in `src/lib/` (no `server-only`) on purpose: the login form is a
 * Client Component and the seed script is a standalone Node process, and
 * both import it. That's fine precisely because nothing here is a secret
 * — a demo password shipped in the client bundle is the documented,
 * intended behaviour of demo mode, which is exactly why
 * `.env.example` says that flag must never be set on a real deployment.
 */
export const DEMO_LOGIN_EMAIL = "demo@pfw.local";
export const DEMO_LOGIN_PASSWORD = "demopassword123";
