"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Spinner } from "../../../components/spinner/spinner";
import { ToggleSwitch } from "../../../components/toggle/toggle-switch";

const ASSET_TYPES = [
  { value: "PROPERTY", label: "Property" },
  { value: "VEHICLE", label: "Vehicle" },
  { value: "CRYPTO", label: "Crypto" },
  { value: "PENSION", label: "Pension" },
  { value: "KEREN_HISHTALMUT", label: "Keren Hishtalmut" },
  { value: "OTHER", label: "Other" },
] as const;

export function CreateAssetForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [assetType, setAssetType] = useState<(typeof ASSET_TYPES)[number]["value"]>("PROPERTY");
  const [currentValue, setCurrentValue] = useState("");
  const [taxAdvantaged, setTaxAdvantaged] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || !currentValue.trim()) return;

    setIsSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          assetType,
          currentValue: currentValue.trim(),
          taxAdvantaged,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to add asset");
      }
      setName("");
      setCurrentValue("");
      setTaxAdvantaged(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add asset");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor="asset-name" className="text-xs font-medium text-muted">
          Name
        </label>
        <input
          id="asset-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="דירה בתל אביב"
          className="min-w-[160px] rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="asset-type" className="text-xs font-medium text-muted">
          Type
        </label>
        <select
          id="asset-type"
          value={assetType}
          onChange={(event) => setAssetType(event.target.value as (typeof ASSET_TYPES)[number]["value"])}
          className="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {ASSET_TYPES.map((type) => (
            <option key={type.value} value={type.value}>
              {type.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="asset-value" className="text-xs font-medium text-muted">
          Current value (₪)
        </label>
        <input
          id="asset-value"
          inputMode="decimal"
          value={currentValue}
          onChange={(event) => setCurrentValue(event.target.value)}
          placeholder="500000.00"
          className="w-32 rounded-md border border-border bg-bg px-3 py-2 font-tabular-figures text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <div className="pb-2">
        <ToggleSwitch id="asset-tax-advantaged" checked={taxAdvantaged} onChange={setTaxAdvantaged} label="Tax-advantaged" />
      </div>
      <button
        type="submit"
        disabled={isSubmitting}
        className="uv-btn-press flex items-center gap-2 rounded-md border border-border bg-accent px-4 py-2 text-sm font-medium text-bg transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {isSubmitting && <Spinner />}
        {isSubmitting ? "Adding…" : "Add asset"}
      </button>
      {error && <p className="w-full text-sm text-negative">{error}</p>}
    </form>
  );
}
