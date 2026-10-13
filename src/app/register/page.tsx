import Link from "next/link";
import { isRegistrationOpen } from "../../server/env";
import { RegisterForm } from "./_components/register-form";

export const instant = false;

function SignInLink() {
  return (
    <Link
      href="/login"
      className="text-accent-ink underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      Sign in
    </Link>
  );
}

/**
 * Sign-up is closed unless `REGISTRATION_OPEN=true` (env.ts). When it is
 * closed this page says so instead of showing a form whose submission the
 * route would refuse anyway — the route is the actual gate, this only
 * spares a visitor a form that cannot work.
 */
export default function RegisterPage() {
  const open = isRegistrationOpen();

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-6">
        {open ? (
          <>
            <h1 className="font-display text-xl font-semibold text-fg">Create your account</h1>
            <p className="mt-1 text-sm text-muted">PFW — personal finance</p>
            <RegisterForm />
            <p className="mt-4 text-center text-sm text-muted">
              Already have an account? <SignInLink />
            </p>
          </>
        ) : (
          <>
            <h1 className="font-display text-xl font-semibold text-fg">Sign-up is closed</h1>
            <p className="mt-1 text-sm text-muted">PFW — personal finance</p>
            <p className="mt-4 text-sm text-fg">This is a private app, and new accounts can&rsquo;t be created here.</p>
            <p className="mt-4 text-center text-sm text-muted">
              Already have an account? <SignInLink />
            </p>
          </>
        )}
      </div>
    </div>
  );
}
