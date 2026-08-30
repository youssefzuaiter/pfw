"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Spinner } from "../spinner/spinner";

export function AcceptInviteForm() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token.trim()) return;

    setIsSubmitting(true);
    setError(null);
    setSuccess(false);
    try {
      const response = await fetch("/api/groups/invites/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Failed to accept invite");

      setToken("");
      setSuccess(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to accept invite");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor="invite-token" className="text-xs font-medium text-muted">
          Invite token
        </label>
        <input
          id="invite-token"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="Paste the token you were sent"
          className="min-w-[260px] rounded-md border border-border bg-bg px-3 py-2 font-tabular-figures text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <button
        type="submit"
        disabled={isSubmitting || !token.trim()}
        className="uv-btn-press flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium text-fg hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {isSubmitting && <Spinner />}
        Join household
      </button>
      {success && <span className="text-xs text-positive">Joined!</span>}
      {error && <span className="text-xs text-negative">{error}</span>}
    </form>
  );
}
