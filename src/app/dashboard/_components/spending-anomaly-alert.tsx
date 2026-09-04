"use client";

import { useEffect, useRef, useState } from "react";
import { Badge } from "../../../components/badge/badge";
import type { AnomalyCheckResponse, RawSpendingTransaction } from "../../../lib/ml/anomaly-worker-handlers";
import { runAnomalyCheck } from "../../../lib/ml/anomaly-client";

function humanizeCategory(category: string): string {
  return category.charAt(0).toUpperCase() + category.slice(1);
}

function buildAlertMessage(result: AnomalyCheckResponse): string {
  if (result.topCategory) {
    return `Unusual velocity detected in your ${humanizeCategory(result.topCategory)} category over the last 48 hours.`;
  }
  if (result.topFeature === "max_3h_burst_count") {
    return "Unusual transaction velocity detected — several transactions landed in a short window over the last 48 hours.";
  }
  if (result.topFeature === "transaction_count") {
    return "An unusually high number of transactions in the last day.";
  }
  return "Your overall spending pattern looks unusual compared to your recent history.";
}

/**
 * Silent, on-device check for irregular spending patterns (AGENTS.md,
 * "Behavioral Spending Anomaly Detection") — an LSTM autoencoder
 * (ml-pipeline/train_autoencoder.py), run entirely in the browser via
 * ONNX Runtime Web inside src/lib/ml/anomaly-worker.ts. No financial
 * data ever leaves the device to compute this, the same property this
 * app's other client-side models already hold (§3u, §3dd, §3aa).
 *
 * Deliberately renders NOTHING while checking and nothing at all for a
 * NORMAL result — this runs silently in the background on every
 * dashboard load; the only visible output is the alert card itself, and
 * only when the model's own bootstrap-CI threshold is actually crossed.
 * A MARGINAL result gets a softer style than HIGH — the model's own
 * three-tier design (ml-pipeline/train_autoencoder.py) treats MARGINAL as
 * "within the threshold's own statistical uncertainty band, worth a
 * look," not a confident anomaly.
 */
export function SpendingAnomalyAlert({
  transactions,
  windowEndDateKey,
}: {
  transactions: readonly RawSpendingTransaction[];
  windowEndDateKey: string;
}) {
  const [result, setResult] = useState<AnomalyCheckResponse | null>(null);
  const requestedRef = useRef(false);

  useEffect(() => {
    if (requestedRef.current) return; // React 19 Strict Mode double-invokes effects — never run this twice
    requestedRef.current = true;

    // Deferred, not synchronous in the effect body — same
    // react-hooks/set-state-in-effect avoidance runway-forecast-chart.tsx's
    // own identically-shaped effect already establishes.
    void (async () => {
      if (typeof Worker === "undefined") return; // unsupported browser — this is a silent background check, never a blocking requirement
      try {
        const response = await runAnomalyCheck({ transactions: [...transactions], windowEndDateKey });
        if (response.tier !== "NORMAL") setResult(response);
      } catch {
        // Silent on purpose — a background anomaly check failing must
        // never surface as a visible error; every other dashboard figure
        // is completely unaffected by it.
      }
    })();
    // Runs once on mount with the props as they were at that moment —
    // same "no re-check on every prop identity change" shape as
    // RunwayForecastChart; a genuinely new check only happens on a real
    // page navigation/remount, when the props would change anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!result) return null;

  const isHigh = result.tier === "HIGH";

  return (
    <div
      role="alert"
      className={
        isHigh ? "rounded-lg border border-negative/40 bg-negative/10 p-4" : "rounded-lg border border-signature/40 bg-signature/10 p-4"
      }
    >
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <Badge variant={isHigh ? "critical" : "warning"} pulse={isHigh}>
          {isHigh ? "Unusual activity" : "Worth a look"}
        </Badge>
        <Badge variant="neutral">experimental</Badge>
      </div>
      <p className="text-sm text-fg">{buildAlertMessage(result)}</p>
      <p className="mt-1 text-xs text-muted">
        Detected on-device by comparing your recent spending against your own history — a small model trained on
        synthetic data, treat it as a prompt to double-check, not a confirmed problem.
      </p>
    </div>
  );
}
