"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Spinner } from "../../../../components/spinner/spinner";

type Status = "ACTIVE" | "REVIEWED" | "CANCELLED";

export function SubscriptionStatusToggle({ merchantKey, status }: { merchantKey: string; status: Status }) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function setStatus(nextStatus: Status) {
    setIsSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/subscriptions/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merchantKey, status: nextStatus }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to update subscription status");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update subscription status");
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleMarkReviewed() {
    void setStatus("REVIEWED");
  }

  function handleCancel() {
    void setStatus("CANCELLED");
  }

  function handleReactivate() {
    void setStatus("ACTIVE");
  }

  return (
    <div className="flex items-center gap-1.5">
      {status === "CANCELLED" ? (
        <button
          type="button"
          onClick={handleReactivate}
          disabled={isSubmitting}
          className="uv-btn-press rounded-md border border-border px-2 py-1 text-xs font-medium text-fg hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {isSubmitting && <Spinner />} Reactivate
        </button>
      ) : (
        <>
          {status !== "REVIEWED" && (
            <button
              type="button"
              onClick={handleMarkReviewed}
              disabled={isSubmitting}
              className="uv-btn-press rounded-md border border-border px-2 py-1 text-xs font-medium text-fg hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              Mark reviewed
            </button>
          )}
          <button
            type="button"
            onClick={handleCancel}
            disabled={isSubmitting}
            className="uv-btn-press rounded-md border border-border px-2 py-1 text-xs font-medium text-negative hover:bg-negative/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {isSubmitting && <Spinner />} Cancel
          </button>
        </>
      )}
      {error && <span className="text-xs text-negative">{error}</span>}
    </div>
  );
}
