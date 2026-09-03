import { VerifyEmailConfirm } from "./_components/verify-email-confirm";

export const instant = false;

/**
 * The email-verification landing page (auth hardening pass, ad hoc
 * post-§3ff) — reached only via the emailed verification link
 * (`src/server/auth/email-verification.ts`'s `sendEmailVerification`),
 * never linked from the app's own navigation. Confirmation happens
 * client-side, not at render time — same "don't burn a single-use token
 * on a GET/prefetch" reasoning `reset-password/[token]/page.tsx`'s own
 * doc comment gives.
 */
export default async function VerifyEmailPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-6">
        <h1 className="font-display text-xl font-semibold text-fg">Verify your email</h1>
        <p className="mt-1 text-sm text-muted">PFW — personal finance</p>
        <VerifyEmailConfirm token={token} />
      </div>
    </div>
  );
}
