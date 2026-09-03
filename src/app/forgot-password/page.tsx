import Link from "next/link";
import { ForgotPasswordForm } from "./_components/forgot-password-form";

export const instant = false;

export default function ForgotPasswordPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-6">
        <h1 className="font-display text-xl font-semibold text-fg">Reset your password</h1>
        <p className="mt-1 text-sm text-muted">Enter your email and we&apos;ll send you a reset link.</p>
        <ForgotPasswordForm />
        <p className="mt-4 text-center text-sm text-muted">
          <Link
            href="/login"
            className="text-accent-ink underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
