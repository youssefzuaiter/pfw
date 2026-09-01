"use client";

import { useRouter } from "next/navigation";
import { useState, type ChangeEvent, type FormEvent } from "react";
import { Badge } from "../../../components/badge/badge";
import { Spinner } from "../../../components/spinner/spinner";

type Props = { initialEnabled: boolean; initialPending: boolean };

type SetupData = { secret: string; otpauthUri: string; qrCodeDataUrl: string };

/**
 * TOTP MFA setup/confirm/disable (Punch List Tier 2, item 3). Named
 * handler functions throughout, never an inline arrow directly on a
 * button or anchor element — this codebase's focus-visible guard test
 * regex reads the literal `>` inside `=>` as the tag's own closing
 * bracket and truncates everything after it, a documented, repeatedly-
 * hit trap (AGENTS.md §3c bug #2, hit again in §3d/§3r/§3s/§3t/§3ff —
 * including the "a doc comment mentioning the tag name in prose trips
 * the same regex" shape those same sections also document).
 */
export function MfaPanel({ initialEnabled, initialPending }: Props) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [mode, setMode] = useState<"idle" | "setup" | "disable">(initialPending ? "setup" : "idle");
  const [setupData, setSetupData] = useState<SetupData | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  async function handleBeginSetup() {
    setIsBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/mfa/setup", { method: "POST" });
      if (!response.ok) throw new Error("Failed to start MFA setup");
      const data = (await response.json()) as SetupData;
      setSetupData(data);
      setMode("setup");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start MFA setup");
    } finally {
      setIsBusy(false);
    }
  }

  async function handleConfirmSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/mfa/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error === "invalid_code" ? "Incorrect code — try again" : "Failed to confirm setup");
      }
      setEnabled(true);
      setMode("idle");
      setSetupData(null);
      setCode("");
      setStatusMessage("Two-factor authentication enabled.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to confirm setup");
    } finally {
      setIsBusy(false);
    }
  }

  async function handleDisable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/mfa/disable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to disable MFA");
      }
      setEnabled(false);
      setMode("idle");
      setPassword("");
      setStatusMessage("Two-factor authentication disabled. Other signed-in devices have been signed out.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disable MFA");
    } finally {
      setIsBusy(false);
    }
  }

  function handleOpenDisable() {
    setError(null);
    setMode("disable");
  }

  function handleCancel() {
    setMode("idle");
    setSetupData(null);
    setCode("");
    setPassword("");
    setError(null);
  }

  function handleCodeChange(event: ChangeEvent<HTMLInputElement>) {
    setCode(event.target.value);
  }

  function handlePasswordChange(event: ChangeEvent<HTMLInputElement>) {
    setPassword(event.target.value);
  }

  if (mode === "setup") {
    return (
      <section className="rounded-lg border border-border bg-surface p-4">
        <h3 className="text-sm font-semibold text-fg">Set up two-factor authentication</h3>
        <p className="mt-1 text-xs text-muted">
          Scan this QR code with an authenticator app (Google Authenticator, Authy, 1Password, …), then enter the
          6-digit code it shows.
        </p>
        <button
          type="button"
          onClick={handleBeginSetup}
          disabled={isBusy}
          className="uv-btn-press mt-3 flex items-center gap-1.5 rounded-md border border-border bg-accent px-3 py-1.5 text-xs font-medium text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {isBusy && <Spinner />} {setupData ? "Regenerate QR code" : "Generate QR code"}
        </button>

        {setupData && (
          <div className="mt-4 flex flex-col items-start gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- a server-generated data: URL, not a remote image Next's optimizer can process */}
            <img
              src={setupData.qrCodeDataUrl}
              alt="Scan this QR code with your authenticator app"
              width={200}
              height={200}
              className="rounded-md border border-border"
            />
            <p className="text-xs text-muted">
              Can&apos;t scan? Enter this code manually:{" "}
              <code className="font-tabular-figures">{setupData.secret}</code>
            </p>
            <form onSubmit={handleConfirmSetup} className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1">
                <label htmlFor="mfa-confirm-code" className="text-xs font-medium text-muted">
                  6-digit code
                </label>
                <input
                  id="mfa-confirm-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={handleCodeChange}
                  className="w-32 rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg font-tabular-figures focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              <button
                type="submit"
                disabled={isBusy || code.length !== 6}
                className="uv-btn-press flex items-center gap-1.5 rounded-md border border-border bg-accent px-3 py-1.5 text-xs font-medium text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                {isBusy && <Spinner />} Confirm
              </button>
              <button
                type="button"
                onClick={handleCancel}
                className="rounded-md px-2 py-1.5 text-xs text-muted hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Cancel
              </button>
            </form>
          </div>
        )}
        {error && <p className="mt-2 text-xs text-negative">{error}</p>}
      </section>
    );
  }

  if (mode === "disable") {
    return (
      <section className="rounded-lg border border-border bg-surface p-4">
        <h3 className="text-sm font-semibold text-fg">Disable two-factor authentication</h3>
        <p className="mt-1 text-xs text-muted">
          Enter your password to confirm. This will sign every other device out.
        </p>
        <form onSubmit={handleDisable} className="mt-3 flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="mfa-disable-password" className="text-xs font-medium text-muted">
              Password
            </label>
            <input
              id="mfa-disable-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={handlePasswordChange}
              className="w-48 rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <button
            type="submit"
            disabled={isBusy || !password}
            className="uv-btn-press flex items-center gap-1.5 rounded-md border border-border bg-negative px-3 py-1.5 text-xs font-medium text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {isBusy && <Spinner />} Disable
          </button>
          <button
            type="button"
            onClick={handleCancel}
            className="rounded-md px-2 py-1.5 text-xs text-muted hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Cancel
          </button>
        </form>
        {error && <p className="mt-2 text-xs text-negative">{error}</p>}
      </section>
    );
  }

  return (
    <section className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-3 text-sm">
      <Badge variant={enabled ? "positive" : "neutral"}>
        {enabled ? "Two-factor enabled" : "Two-factor disabled"}
      </Badge>
      {statusMessage && <span className="text-xs text-muted">{statusMessage}</span>}
      <button
        type="button"
        onClick={enabled ? handleOpenDisable : handleBeginSetup}
        disabled={isBusy}
        className="uv-btn-press ml-auto flex items-center gap-1.5 rounded-md border border-border px-3 py-1 text-xs font-medium text-fg hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {isBusy && <Spinner />} {enabled ? "Disable" : "Enable"}
      </button>
      {error && <p className="w-full text-xs text-negative">{error}</p>}
    </section>
  );
}
