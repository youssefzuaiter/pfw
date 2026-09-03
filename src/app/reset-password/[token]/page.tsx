import { ResetPasswordForm } from "./_components/reset-password-form";

export const instant = false;

/**
 * The password-reset landing page (auth hardening pass, ad hoc
 * post-§3ff) — reached only via the emailed reset link
 * (`src/server/auth/password-reset.ts`'s `requestPasswordReset`), never
 * linked anywhere in the app's own navigation. Deliberately does NOT
 * validate the token server-side at render time — `POST
 * /api/auth/reset-password` is the single source of truth for
 * valid/expired/consumed, so an email scanner's link-prefetch (a real,
 * known failure mode for GET-based single-use links) can't burn the
 * token just by rendering this page.
 */
export default async function ResetPasswordPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-6">
        <h1 className="font-display text-xl font-semibold text-fg">Set a new password</h1>
        <p className="mt-1 text-sm text-muted">PFW — personal finance</p>
        <ResetPasswordForm token={token} />
      </div>
    </div>
  );
}
