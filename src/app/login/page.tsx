import Link from "next/link";
import { LoginForm } from "./_components/login-form";

export const instant = false;

function firstString(value: string | string[] | undefined, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const from = firstString(params.from, "/dashboard");

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-6">
        <h1 className="font-display text-xl font-semibold text-fg">Sign in</h1>
        <p className="mt-1 text-sm text-muted">PFW — personal finance</p>
        <LoginForm redirectTo={from} />
        <p className="mt-4 text-center text-sm text-muted">
          No account?{" "}
          <Link
            href="/register"
            className="text-accent-ink underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Register
          </Link>
        </p>
      </div>
    </div>
  );
}
