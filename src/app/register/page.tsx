import Link from "next/link";
import { RegisterForm } from "./_components/register-form";

export const instant = false;

export default function RegisterPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-6">
        <h1 className="font-display text-xl font-semibold text-fg">Create your account</h1>
        <p className="mt-1 text-sm text-muted">PFW — personal finance</p>
        <RegisterForm />
        <p className="mt-4 text-center text-sm text-muted">
          Already have an account?{" "}
          <Link
            href="/login"
            className="text-accent-ink underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
