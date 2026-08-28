import { addAgorot, type Agorot } from "../money";
import { computeRank, type Insight } from "./types";

const WARNING_SHARE = 0.4;
const CRITICAL_SHARE = 0.6;

export type HoldingValue = {
  symbol: string;
  currentValue: Agorot;
};

/** Flags any single holding that dominates the simulated portfolio — including a lone 100%-share holding, which is the clearest concentration risk of all. */
export function generatePortfolioConcentrationInsights(holdings: readonly HoldingValue[]): Insight[] {
  const totalValue = addAgorot(...holdings.map((h) => h.currentValue));
  if (totalValue <= 0) return [];

  const insights: Insight[] = [];

  for (const holding of holdings) {
    const share = holding.currentValue / totalValue;
    if (share < WARNING_SHARE) continue;

    const severity = share >= CRITICAL_SHARE ? "critical" : "warning";
    const percent = Math.round(share * 100);

    insights.push({
      type: "portfolio_concentration",
      severity,
      rank: computeRank(severity, (share - WARNING_SHARE) * 200),
      title: `${holding.symbol} makes up ${percent}% of the portfolio`,
      description: `${holding.symbol} is ${percent}% of total simulated portfolio value — a concentration risk if it drops.`,
      relatedEntityId: holding.symbol,
    });
  }

  return insights;
}
