"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Badge, type BadgeVariant } from "../../../components/badge/badge";
import { Spinner } from "../../../components/spinner/spinner";
import { Tickbar, type TickbarStatus } from "../../../components/tickbar/tickbar";
import { agorot, formatAgorot } from "../../../lib/money";
import type { MonteCarloAnalyticsResponse } from "../../../server/analytics/build-monte-carlo-data";

type MonteCarloApiResponse = MonteCarloAnalyticsResponse;

const DEBOUNCE_MS = 400;

function probabilityStatus(probability: number): { tickbar: TickbarStatus; badge: BadgeVariant } {
  if (probability >= 0.9) return { tickbar: "good", badge: "positive" };
  if (probability >= 0.7) return { tickbar: "warning", badge: "warning" };
  return { tickbar: "critical", badge: "critical" };
}

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { dataKey?: string; value?: number }[];
  label?: number;
}) {
  if (!active || !payload?.length) return null;
  const byKey = Object.fromEntries(payload.map((p) => [p.dataKey, p.value]));
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-lg">
      <p className="text-muted">Age {label}</p>
      {byKey.p90 !== undefined && (
        <p className="font-tabular-figures text-fg">Top 10%: {formatAgorot(agorot(Math.round(byKey.p90)))}</p>
      )}
      {byKey.p50 !== undefined && (
        <p className="font-tabular-figures font-medium text-fg">Median: {formatAgorot(agorot(Math.round(byKey.p50)))}</p>
      )}
      {byKey.p10 !== undefined && (
        <p className="font-tabular-figures text-fg">Bottom 10%: {formatAgorot(agorot(Math.round(byKey.p10)))}</p>
      )}
    </div>
  );
}

export function MonteCarloWidget({
  initialCurrentAge,
  initialData,
}: {
  initialCurrentAge: number;
  initialData: MonteCarloApiResponse;
}) {
  const [currentAge, setCurrentAge] = useState(initialCurrentAge);
  const [retirementAge, setRetirementAge] = useState(initialData.input.retirementAge);
  const [annualSpendAgorot, setAnnualSpendAgorot] = useState(initialData.input.annualSpend.agorot);
  const [volatilityMultiplier, setVolatilityMultiplier] = useState(1);
  const [data, setData] = useState(initialData);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const spendSliderMax = useMemo(
    () => Math.max(initialData.derived.historicalAnnualExpense.agorot * 3, 5_000_000),
    [initialData.derived.historicalAnnualExpense.agorot],
  );

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const timeout = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const params = new URLSearchParams({
        currentAge: String(currentAge),
        retirementAge: String(retirementAge),
        annualSpend: (annualSpendAgorot / 100).toFixed(2),
        volatilityMultiplier: volatilityMultiplier.toFixed(2),
      });

      setIsLoading(true);
      setError(null);
      fetch(`/api/analytics/monte-carlo?${params.toString()}`, { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.error ?? "Failed to run the simulation");
          }
          return response.json() as Promise<MonteCarloApiResponse>;
        })
        .then((result) => {
          setData(result);
          setIsLoading(false);
        })
        .catch((err) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          setError(err instanceof Error ? err.message : "Failed to run the simulation");
          setIsLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timeout);
  }, [currentAge, retirementAge, annualSpendAgorot, volatilityMultiplier]);

  const chartData = data.yearlyPercentiles.map((point) => ({
    age: point.age,
    p10: point.p10.agorot,
    p50: point.p50.agorot,
    p90: point.p90.agorot,
  }));

  const status = probabilityStatus(data.probabilityOfSuccess);
  const probabilityPercent = data.probabilityOfSuccess * 100;

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-lg border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted">Probability of portfolio survival</p>
            <p className="font-display text-3xl font-semibold text-fg">
              {probabilityPercent.toFixed(1)}%{" "}
              <span className="text-base font-normal text-muted">to age {data.input.endAge}</span>
            </p>
          </div>
          <Badge variant={status.badge} pulse={status.badge === "critical"}>
            {data.numSimulations.toLocaleString()} simulated paths
          </Badge>
        </div>
        <div className="mt-4">
          <Tickbar label="Chance of never running out of money" percent={probabilityPercent} status={status.tickbar} />
        </div>
        {isLoading && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
            <Spinner /> Recalculating…
          </p>
        )}
        {error && <p className="mt-2 text-xs text-negative">{error}</p>}
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">Assumptions</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <label className="flex flex-col gap-1">
            <span className="flex justify-between text-xs font-medium text-muted">
              <span>Retirement age</span>
              <span className="font-tabular-figures text-fg">{retirementAge}</span>
            </span>
            <input
              type="range"
              min={18}
              max={90}
              step={1}
              value={retirementAge}
              onChange={(event) => setRetirementAge(Number(event.target.value))}
              className="accent-accent"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="flex justify-between text-xs font-medium text-muted">
              <span>Target annual spend</span>
              <span className="font-tabular-figures text-fg">{formatAgorot(agorot(annualSpendAgorot))}</span>
            </span>
            <input
              type="range"
              min={0}
              max={spendSliderMax}
              step={50_00}
              value={annualSpendAgorot}
              onChange={(event) => setAnnualSpendAgorot(Number(event.target.value))}
              className="accent-accent"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="flex justify-between text-xs font-medium text-muted">
              <span>Market volatility</span>
              <span className="font-tabular-figures text-fg">{volatilityMultiplier.toFixed(2)}x</span>
            </span>
            <input
              type="range"
              min={0.25}
              max={3}
              step={0.05}
              value={volatilityMultiplier}
              onChange={(event) => setVolatilityMultiplier(Number(event.target.value))}
              className="accent-accent"
            />
          </label>
        </div>
        <label className="mt-4 flex flex-col gap-1 sm:w-48">
          <span className="flex justify-between text-xs font-medium text-muted">
            <span>Your current age</span>
            <span className="font-tabular-figures text-fg">{currentAge}</span>
          </span>
          <input
            type="range"
            min={18}
            max={90}
            step={1}
            value={currentAge}
            onChange={(event) => setCurrentAge(Number(event.target.value))}
            className="accent-accent"
          />
        </label>
        <p className="mt-3 text-xs text-muted">
          Starting net worth {data.derived.startingNetWorth.formatted} and{" "}
          {(data.derived.growthAllocationShare * 100).toFixed(0)}% growth allocation come from your real accounts.
          Annual savings default ({data.derived.historicalAnnualSavings.formatted}) is your recent average monthly
          cash flow, annualized. This app has no stored date of birth, so age is entered here each time, never saved.
        </p>
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">Projected net worth range</h2>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="age" className="fill-muted text-xs" tickLine={false} axisLine={false} />
              <YAxis
                className="fill-muted text-xs"
                tickLine={false}
                axisLine={false}
                width={72}
                tickFormatter={(value: number) => formatAgorot(agorot(Math.round(value)))}
              />
              <Tooltip content={<ChartTooltip />} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line
                type="monotone"
                dataKey="p90"
                name="Top 10%"
                stroke="currentColor"
                className="text-positive"
                strokeDasharray="4 4"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="p50"
                name="Median"
                stroke="currentColor"
                className="text-accent"
                strokeWidth={2.5}
                dot={false}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="p10"
                name="Bottom 10%"
                stroke="currentColor"
                className="text-negative"
                strokeDasharray="4 4"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-2 text-xs text-muted">
          Median final balance at age {data.input.endAge}: {data.medianFinalBalance.formatted}. In the worst 10% of
          simulated paths: {data.worstDecileFinalBalance.formatted}.
        </p>
      </section>
    </div>
  );
}
