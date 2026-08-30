"use client";

import { useEffect, useRef, useState } from "react";
import { Badge } from "../../../components/badge/badge";
import { Spinner } from "../../../components/spinner/spinner";
import { neutralizeFormulaInjection } from "../../../lib/csv-import/formula-injection";
import { agorot, formatAgorot } from "../../../lib/money";
import type { CostBasisMethod } from "../../../lib/tax-lots";
import type { TaxJurisdiction } from "../../../lib/tax-rules";
import type { TaxSimulationResponse } from "../../../server/tax/build-tax-data";
import { HarvestRadarList } from "./harvest-radar-list";
import { TaxLotsTable } from "./tax-lots-table";

const DEBOUNCE_MS = 400;

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-[10rem] flex-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="font-tabular-figures text-lg font-semibold text-fg">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

function csvCell(value: string): string {
  const escaped = neutralizeFormulaInjection(value).replace(/"/g, '""');
  return `"${escaped}"`;
}

function buildCsv(data: TaxSimulationResponse): string {
  const lines: string[] = [];

  lines.push(`Multi-Jurisdiction Capital Gains Tax Summary — ${data.jurisdiction} / ${data.method}, as of ${data.asOf.slice(0, 10)}`);
  lines.push("");
  lines.push("Summary,Amount (agorot)");
  lines.push(`Realized this year — tax owed,${data.realizedThisYear.taxOwed.agorot}`);
  lines.push(`If liquidated today — tax owed,${data.ifLiquidatedToday.taxOwed.agorot}`);
  lines.push(`Additional tax if liquidated today,${data.additionalTaxIfLiquidated.agorot}`);
  lines.push(`Total harvestable loss,${data.harvestSummary.totalHarvestableLoss.agorot}`);
  lines.push(`Estimated harvest tax savings,${data.harvestSummary.totalEstimatedTaxSavings.agorot}`);
  lines.push("");

  lines.push("Open Lots");
  lines.push(
    ["Symbol", "Name", "Acquired", "Quantity", "Cost Basis (agorot)", "Current Value (agorot)", "Unrealized Gain (agorot)", "Holding Period (days)", "Term"]
      .map(csvCell)
      .join(","),
  );
  for (const lot of data.openLots) {
    lines.push(
      [
        csvCell(lot.symbol),
        csvCell(lot.symbolName),
        csvCell(lot.acquiredAt.slice(0, 10)),
        lot.quantity.toFixed(8),
        String(lot.costBasis.agorot),
        String(lot.currentValue.agorot),
        String(lot.unrealizedGain.agorot),
        String(lot.holdingPeriodDays),
        csvCell(lot.term),
      ].join(","),
    );
  }
  lines.push("");

  lines.push("Tax-Loss Harvesting Candidates");
  lines.push(
    ["Symbol", "Name", "Acquired", "Quantity", "Unrealized Loss (agorot)", "Holding Period (days)", "Wash-Sale Risk", "Estimated Tax Savings (agorot)"]
      .map(csvCell)
      .join(","),
  );
  for (const candidate of data.harvestCandidates) {
    lines.push(
      [
        csvCell(candidate.symbol),
        csvCell(candidate.symbolName),
        csvCell(candidate.acquiredAt.slice(0, 10)),
        candidate.quantity.toFixed(8),
        String(candidate.unrealizedLoss.agorot),
        String(candidate.holdingPeriodDays),
        candidate.washSaleRisk ? "yes" : "no",
        String(candidate.estimatedTaxSavings.agorot),
      ].join(","),
    );
  }

  return lines.join("\n");
}

function downloadCsv(data: TaxSimulationResponse): void {
  const csv = buildCsv(data);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `pfw-tax-summary-${data.jurisdiction.toLowerCase()}-${data.method.toLowerCase()}-${data.asOf.slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function TaxSimulator({ initialData }: { initialData: TaxSimulationResponse }) {
  const [method, setMethod] = useState<CostBasisMethod>(initialData.method);
  const [jurisdiction, setJurisdiction] = useState<TaxJurisdiction>(initialData.jurisdiction);
  const [otherOrdinaryIncomeAgorot, setOtherOrdinaryIncomeAgorot] = useState(initialData.profile.otherOrdinaryIncome.agorot);
  const [includeNiit, setIncludeNiit] = useState(initialData.profile.includeNiit);
  const [churchTaxRate, setChurchTaxRate] = useState(initialData.profile.churchTaxRate);
  const [annualAllowanceAgorot, setAnnualAllowanceAgorot] = useState(initialData.profile.annualAllowance.agorot);
  const [flatRatePercent, setFlatRatePercent] = useState(initialData.profile.flatRatePercent);

  const [data, setData] = useState(initialData);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const timeout = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const params = new URLSearchParams({
        method,
        jurisdiction,
        otherOrdinaryIncome: (otherOrdinaryIncomeAgorot / 100).toFixed(2),
        includeNiit: String(includeNiit),
        churchTaxRate: churchTaxRate.toFixed(2),
        annualAllowance: (annualAllowanceAgorot / 100).toFixed(2),
        flatRatePercent: flatRatePercent.toFixed(2),
      });

      setIsLoading(true);
      setError(null);
      fetch(`/api/tax/simulate?${params.toString()}`, { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.error ?? "Failed to run the tax simulation");
          }
          return response.json() as Promise<TaxSimulationResponse>;
        })
        .then((result) => {
          setData(result);
          setIsLoading(false);
        })
        .catch((err) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          setError(err instanceof Error ? err.message : "Failed to run the tax simulation");
          setIsLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timeout);
  }, [method, jurisdiction, otherOrdinaryIncomeAgorot, includeNiit, churchTaxRate, annualAllowanceAgorot, flatRatePercent]);

  function handleExportClick() {
    downloadCsv(data);
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-lg border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted">Simulated liability</p>
            <p className="font-display text-2xl font-semibold text-fg">
              {formatAgorot(agorot(data.realizedThisYear.taxOwed.agorot))}{" "}
              <span className="text-sm font-normal text-muted">owed on gains realized so far this year</span>
            </p>
          </div>
          <button
            type="button"
            onClick={handleExportClick}
            className="uv-btn-press rounded-md border border-border px-3 py-1.5 text-xs font-medium text-fg hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Export summary (CSV)
          </button>
        </div>
        <div className="mt-4 flex flex-wrap gap-6">
          <Stat label="If liquidated today" value={formatAgorot(agorot(data.ifLiquidatedToday.taxOwed.agorot))} />
          <Stat
            label="Additional tax to liquidate"
            value={formatAgorot(agorot(data.additionalTaxIfLiquidated.agorot), { showPositiveSign: true })}
            hint="Beyond what's already realized this year"
          />
          <Stat label="Taxable gain (realized)" value={formatAgorot(agorot(data.realizedThisYear.taxableGain.agorot))} />
          <Stat
            label="Effective rate (realized)"
            value={data.realizedThisYear.effectiveRate === null ? "—" : `${(data.realizedThisYear.effectiveRate * 100).toFixed(1)}%`}
          />
        </div>
        {isLoading && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
            <Spinner /> Recalculating…
          </p>
        )}
        {error && <p className="mt-2 text-xs text-negative">{error}</p>}
        <ul className="mt-3 flex flex-col gap-1 text-xs text-muted">
          {data.realizedThisYear.notes.map((note) => (
            <li key={note}>· {note}</li>
          ))}
        </ul>
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">Cost basis method &amp; tax profile</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Cost basis method</span>
            <select
              value={method}
              onChange={(event) => setMethod(event.target.value as CostBasisMethod)}
              className="rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="FIFO">FIFO — first shares bought, first sold</option>
              <option value="LIFO">LIFO — most recent shares sold first</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Jurisdiction</span>
            <select
              value={jurisdiction}
              onChange={(event) => setJurisdiction(event.target.value as TaxJurisdiction)}
              className="rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="US">United States (federal, single filer)</option>
              <option value="DE">Germany (Abgeltungssteuer)</option>
              <option value="INTL">International (generic flat rate)</option>
            </select>
          </label>
        </div>

        {jurisdiction === "US" && (
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="flex justify-between text-xs font-medium text-muted">
                <span>Other ordinary income this year</span>
                <span className="font-tabular-figures text-fg">{formatAgorot(agorot(otherOrdinaryIncomeAgorot))}</span>
              </span>
              <input
                type="range"
                min={0}
                max={200_000_00}
                step={1_000_00}
                value={otherOrdinaryIncomeAgorot}
                onChange={(event) => setOtherOrdinaryIncomeAgorot(Number(event.target.value))}
                className="accent-accent"
              />
            </label>
            <label className="flex items-center gap-2 pt-5">
              <input
                type="checkbox"
                checked={includeNiit}
                onChange={(event) => setIncludeNiit(event.target.checked)}
                className="h-4 w-4 accent-accent"
              />
              <span className="text-xs font-medium text-muted">Include 3.8% Net Investment Income Tax surtax</span>
            </label>
          </div>
        )}

        {jurisdiction === "DE" && (
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="flex justify-between text-xs font-medium text-muted">
                <span>Annual allowance (Sparer-Pauschbetrag)</span>
                <span className="font-tabular-figures text-fg">{formatAgorot(agorot(annualAllowanceAgorot))}</span>
              </span>
              <input
                type="range"
                min={0}
                max={2_000_00}
                step={10_00}
                value={annualAllowanceAgorot}
                onChange={(event) => setAnnualAllowanceAgorot(Number(event.target.value))}
                className="accent-accent"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="flex justify-between text-xs font-medium text-muted">
                <span>Church tax (Kirchensteuer)</span>
                <span className="font-tabular-figures text-fg">{(churchTaxRate * 100).toFixed(0)}%</span>
              </span>
              <input
                type="range"
                min={0}
                max={0.09}
                step={0.01}
                value={churchTaxRate}
                onChange={(event) => setChurchTaxRate(Number(event.target.value))}
                className="accent-accent"
              />
            </label>
          </div>
        )}

        {jurisdiction === "INTL" && (
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="flex justify-between text-xs font-medium text-muted">
                <span>Flat capital-gains rate</span>
                <span className="font-tabular-figures text-fg">{(flatRatePercent * 100).toFixed(0)}%</span>
              </span>
              <input
                type="range"
                min={0}
                max={0.5}
                step={0.01}
                value={flatRatePercent}
                onChange={(event) => setFlatRatePercent(Number(event.target.value))}
                className="accent-accent"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="flex justify-between text-xs font-medium text-muted">
                <span>Annual tax-free allowance</span>
                <span className="font-tabular-figures text-fg">{formatAgorot(agorot(annualAllowanceAgorot))}</span>
              </span>
              <input
                type="range"
                min={0}
                max={2_000_00}
                step={10_00}
                value={annualAllowanceAgorot}
                onChange={(event) => setAnnualAllowanceAgorot(Number(event.target.value))}
                className="accent-accent"
              />
            </label>
          </div>
        )}

        <p className="mt-4 text-xs text-muted">
          This is a simulator, not a filing tool. Bracket thresholds are illustrative — see the notes above the summary
          for what each jurisdiction does and doesn&apos;t model.
        </p>
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">Open tax lots</h2>
        {data.openLots.length === 0 ? (
          <p className="text-sm text-muted">No open positions.</p>
        ) : (
          <TaxLotsTable rows={data.openLots} />
        )}
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted">Tax-loss harvesting radar</h2>
          {data.harvestCandidates.length > 0 && (
            <Badge variant="warning">
              ~{formatAgorot(agorot(data.harvestSummary.totalEstimatedTaxSavings.agorot))} potential savings
            </Badge>
          )}
        </div>
        <HarvestRadarList candidates={data.harvestCandidates} />
      </section>
    </div>
  );
}
