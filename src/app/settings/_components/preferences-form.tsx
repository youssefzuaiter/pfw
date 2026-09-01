"use client";

import { useRouter } from "next/navigation";
import { useState, type ChangeEvent, type FormEvent } from "react";
import { Spinner } from "../../../components/spinner/spinner";
import { setCurrencyDisplayMode } from "../../../lib/hooks/use-currency-display-mode";

type LiquidityTier = "LIQUID" | "SEMI_LIQUID" | "ILLIQUID";

export type PreferencesFormData = {
  taxJurisdiction: "US" | "DE" | "INTL";
  taxMethod: "FIFO" | "LIFO";
  taxOtherOrdinaryIncome: number;
  taxIncludeNiit: boolean;
  taxChurchTaxRate: number;
  taxAnnualAllowance: number | null;
  taxFlatRatePercent: number | null;
  monteCarloRetirementAge: number;
  monteCarloTargetAnnualSpend: number | null;
  monteCarloVolatilityMultiplier: number;
  defaultManualAssetLiquidityTier: LiquidityTier | null;
  preferredCurrencyDisplay: "NATIVE" | "ILS";
};

/**
 * Saved defaults for the tax simulator (§3r) and Monte Carlo widget
 * (§3n), plus a default liquidity tier for future ambiguous-type manual
 * assets and the currency-display preference (Punch List Tier 2, item 1
 * — see `UserSettings`'s own schema doc comment for exactly what this
 * does and doesn't persist). One `PATCH /api/user-settings` on submit,
 * not per-field auto-save — simpler, and every field here is a slow-
 * changing preference, not something that benefits from instant sync.
 *
 * Saving `preferredCurrencyDisplay` ALSO writes through to the
 * localStorage-backed `useCurrencyDisplayMode` hook that every
 * `<CurrencyAmount>` on the app actually reads (Punch List Phase 3) —
 * without this, saving a preference here would change a database row no
 * screen ever consults, which is exactly the kind of inert, half-wired
 * plumbing this app's own conventions warn against. The two stay
 * independent sources otherwise (the hook's own doc comment explains
 * why it's deliberately not server-synced on every read), this is only a
 * one-time push at the moment of an explicit save.
 */
export function PreferencesForm({ initial }: { initial: PreferencesFormData }) {
  const router = useRouter();
  const [form, setForm] = useState(initial);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  function updateField<K extends keyof PreferencesFormData>(key: K, value: PreferencesFormData[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setStatusMessage(null);
  }

  function handleTaxJurisdictionChange(event: ChangeEvent<HTMLSelectElement>) {
    updateField("taxJurisdiction", event.target.value as PreferencesFormData["taxJurisdiction"]);
  }
  function handleTaxMethodChange(event: ChangeEvent<HTMLSelectElement>) {
    updateField("taxMethod", event.target.value as PreferencesFormData["taxMethod"]);
  }
  function handleOtherIncomeChange(event: ChangeEvent<HTMLInputElement>) {
    updateField("taxOtherOrdinaryIncome", Number(event.target.value));
  }
  function handleIncludeNiitChange(event: ChangeEvent<HTMLInputElement>) {
    updateField("taxIncludeNiit", event.target.checked);
  }
  function handleChurchTaxRateChange(event: ChangeEvent<HTMLInputElement>) {
    updateField("taxChurchTaxRate", Number(event.target.value));
  }
  function handleAnnualAllowanceChange(event: ChangeEvent<HTMLInputElement>) {
    updateField("taxAnnualAllowance", event.target.value === "" ? null : Number(event.target.value));
  }
  function handleFlatRateChange(event: ChangeEvent<HTMLInputElement>) {
    updateField("taxFlatRatePercent", event.target.value === "" ? null : Number(event.target.value));
  }
  function handleRetirementAgeChange(event: ChangeEvent<HTMLInputElement>) {
    updateField("monteCarloRetirementAge", Number(event.target.value));
  }
  function handleTargetSpendChange(event: ChangeEvent<HTMLInputElement>) {
    updateField("monteCarloTargetAnnualSpend", event.target.value === "" ? null : Number(event.target.value));
  }
  function handleVolatilityChange(event: ChangeEvent<HTMLInputElement>) {
    updateField("monteCarloVolatilityMultiplier", Number(event.target.value));
  }
  function handleLiquidityTierChange(event: ChangeEvent<HTMLSelectElement>) {
    updateField(
      "defaultManualAssetLiquidityTier",
      event.target.value === "" ? null : (event.target.value as LiquidityTier),
    );
  }
  function handleCurrencyDisplayChange(event: ChangeEvent<HTMLSelectElement>) {
    updateField("preferredCurrencyDisplay", event.target.value as PreferencesFormData["preferredCurrencyDisplay"]);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/user-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taxJurisdiction: form.taxJurisdiction,
          taxMethod: form.taxMethod,
          taxOtherOrdinaryIncome: String(form.taxOtherOrdinaryIncome),
          taxIncludeNiit: form.taxIncludeNiit,
          taxChurchTaxRate: form.taxChurchTaxRate,
          taxAnnualAllowance: form.taxAnnualAllowance === null ? null : String(form.taxAnnualAllowance),
          taxFlatRatePercent: form.taxFlatRatePercent,
          monteCarloRetirementAge: form.monteCarloRetirementAge,
          monteCarloTargetAnnualSpend:
            form.monteCarloTargetAnnualSpend === null ? null : String(form.monteCarloTargetAnnualSpend),
          monteCarloVolatilityMultiplier: form.monteCarloVolatilityMultiplier,
          defaultManualAssetLiquidityTier: form.defaultManualAssetLiquidityTier,
          preferredCurrencyDisplay: form.preferredCurrencyDisplay,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to save preferences");
      }

      setCurrencyDisplayMode(form.preferredCurrencyDisplay === "NATIVE" ? "native" : "ils");
      setStatusMessage("Preferences saved.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save preferences");
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6 rounded-lg border border-border bg-surface p-4">
      <div>
        <h3 className="text-sm font-semibold text-fg">Currency display</h3>
        <div className="mt-2 flex flex-col gap-1">
          <label htmlFor="pref-currency-display" className="text-xs font-medium text-muted">
            Preferred primary figure for foreign-currency amounts
          </label>
          <select
            id="pref-currency-display"
            value={form.preferredCurrencyDisplay}
            onChange={handleCurrencyDisplayChange}
            className="w-56 rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="ILS">₪ (base currency)</option>
            <option value="NATIVE">Native currency</option>
          </select>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-fg">Tax simulator defaults</h3>
        <p className="mt-1 text-xs text-muted">
          Saved defaults for the tax simulator (/trading/tax) — a per-request query param there still overrides
          these.
        </p>
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="pref-tax-jurisdiction" className="text-xs font-medium text-muted">
              Jurisdiction
            </label>
            <select
              id="pref-tax-jurisdiction"
              value={form.taxJurisdiction}
              onChange={handleTaxJurisdictionChange}
              className="rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="US">United States</option>
              <option value="DE">Germany</option>
              <option value="INTL">Generic / international</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="pref-tax-method" className="text-xs font-medium text-muted">
              Cost-basis method
            </label>
            <select
              id="pref-tax-method"
              value={form.taxMethod}
              onChange={handleTaxMethodChange}
              className="rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="FIFO">FIFO</option>
              <option value="LIFO">LIFO</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="pref-tax-other-income" className="text-xs font-medium text-muted">
              Other ordinary income (₪)
            </label>
            <input
              id="pref-tax-other-income"
              type="number"
              step="0.01"
              value={form.taxOtherOrdinaryIncome}
              onChange={handleOtherIncomeChange}
              className="rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg font-tabular-figures focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <label className="mt-5 flex items-center gap-2 text-xs font-medium text-muted">
            <input type="checkbox" checked={form.taxIncludeNiit} onChange={handleIncludeNiitChange} />
            Include US Net Investment Income Tax surtax
          </label>
          <div className="flex flex-col gap-1">
            <label htmlFor="pref-tax-church-rate" className="text-xs font-medium text-muted">
              German church tax rate (0-1)
            </label>
            <input
              id="pref-tax-church-rate"
              type="number"
              min={0}
              max={1}
              step="0.001"
              value={form.taxChurchTaxRate}
              onChange={handleChurchTaxRateChange}
              className="rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg font-tabular-figures focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="pref-tax-annual-allowance" className="text-xs font-medium text-muted">
              Annual allowance override (₪, blank = default)
            </label>
            <input
              id="pref-tax-annual-allowance"
              type="number"
              step="0.01"
              value={form.taxAnnualAllowance ?? ""}
              onChange={handleAnnualAllowanceChange}
              className="rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg font-tabular-figures focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="pref-tax-flat-rate" className="text-xs font-medium text-muted">
              Generic flat rate (0-1, blank = default)
            </label>
            <input
              id="pref-tax-flat-rate"
              type="number"
              min={0}
              max={1}
              step="0.001"
              value={form.taxFlatRatePercent ?? ""}
              onChange={handleFlatRateChange}
              className="rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg font-tabular-figures focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-fg">Monte Carlo defaults</h3>
        <p className="mt-1 text-xs text-muted">
          Saved defaults for the retirement widget (/analytics) — current age still has no saved default (this app
          never stores a date of birth).
        </p>
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="pref-mc-retirement-age" className="text-xs font-medium text-muted">
              Retirement age
            </label>
            <input
              id="pref-mc-retirement-age"
              type="number"
              min={0}
              max={120}
              value={form.monteCarloRetirementAge}
              onChange={handleRetirementAgeChange}
              className="rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg font-tabular-figures focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="pref-mc-target-spend" className="text-xs font-medium text-muted">
              Target annual spend (₪, blank = derived from history)
            </label>
            <input
              id="pref-mc-target-spend"
              type="number"
              step="0.01"
              value={form.monteCarloTargetAnnualSpend ?? ""}
              onChange={handleTargetSpendChange}
              className="rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg font-tabular-figures focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="pref-mc-volatility" className="text-xs font-medium text-muted">
              Volatility multiplier (0.25-3)
            </label>
            <input
              id="pref-mc-volatility"
              type="number"
              min={0.25}
              max={3}
              step="0.05"
              value={form.monteCarloVolatilityMultiplier}
              onChange={handleVolatilityChange}
              className="rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg font-tabular-figures focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-fg">Manual assets</h3>
        <div className="mt-2 flex flex-col gap-1">
          <label htmlFor="pref-liquidity-tier" className="text-xs font-medium text-muted">
            Default liquidity tier for new OTHER/CRYPTO assets
          </label>
          <select
            id="pref-liquidity-tier"
            value={form.defaultManualAssetLiquidityTier ?? ""}
            onChange={handleLiquidityTierChange}
            className="w-56 rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">No default (use asset-type default)</option>
            <option value="LIQUID">Liquid</option>
            <option value="SEMI_LIQUID">Semi-liquid</option>
            <option value="ILLIQUID">Illiquid</option>
          </select>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={isBusy}
          className="uv-btn-press flex items-center gap-1.5 rounded-md border border-border bg-accent px-4 py-2 text-sm font-medium text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {isBusy && <Spinner />} Save preferences
        </button>
        {statusMessage && <span className="text-xs text-muted">{statusMessage}</span>}
      </div>
      {error && <p className="text-xs text-negative">{error}</p>}
    </form>
  );
}
