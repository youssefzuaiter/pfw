"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const NONE_VALUE = "";

/**
 * An inline "share this into a household" select, reused for any of the
 * three shareable resource types (AGENTS.md §3s). Only ever offers
 * groups the current user actually belongs to — `setResourceSharing`'s
 * own DAL check would reject anything else anyway, but there's no reason
 * to let the user pick and then fail.
 */
export function ShareResourceControl({
  resourceType,
  resourceId,
  groups,
  currentSharedGroupId,
}: {
  resourceType: "budget" | "bankAccount" | "category";
  resourceId: string;
  groups: readonly { id: string; name: string }[];
  currentSharedGroupId: string | null;
}) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (groups.length === 0) return null;

  async function handleChange(value: string) {
    setIsSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/groups/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resourceType, resourceId, sharedGroupId: value === NONE_VALUE ? null : value }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to update sharing");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update sharing");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex items-center gap-1">
      <label className="sr-only" htmlFor={`share-${resourceType}-${resourceId}`}>
        Share with household
      </label>
      <select
        id={`share-${resourceType}-${resourceId}`}
        value={currentSharedGroupId ?? NONE_VALUE}
        disabled={isSubmitting}
        onChange={(event) => handleChange(event.target.value)}
        className="rounded-md border border-border bg-bg px-2 py-1 text-xs text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        <option value={NONE_VALUE}>Personal only</option>
        {groups.map((group) => (
          <option key={group.id} value={group.id}>
            Share: {group.name}
          </option>
        ))}
      </select>
      {error && <span className="text-xs text-negative">{error}</span>}
    </div>
  );
}
