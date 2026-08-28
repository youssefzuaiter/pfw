import { describe, expect, it } from "vitest";
import { agorot } from "../money";
import { generatePortfolioConcentrationInsights } from "./portfolio-concentration";

describe("generatePortfolioConcentrationInsights()", () => {
  it("flags a holding above the critical concentration share", () => {
    const insights = generatePortfolioConcentrationInsights([
      { symbol: "AAPL", currentValue: agorot(70_000) },
      { symbol: "MSFT", currentValue: agorot(30_000) },
    ]);
    expect(insights).toHaveLength(1);
    expect(insights[0]).toMatchObject({ relatedEntityId: "AAPL", severity: "critical" });
  });

  it("flags a warning-level (not critical) concentration", () => {
    const insights = generatePortfolioConcentrationInsights([
      { symbol: "AAPL", currentValue: agorot(45_000) },
      { symbol: "MSFT", currentValue: agorot(35_000) },
      { symbol: "GOOGL", currentValue: agorot(20_000) },
    ]);
    expect(insights).toHaveLength(1);
    expect(insights[0].severity).toBe("warning");
    expect(insights[0].relatedEntityId).toBe("AAPL");
  });

  it("does not flag a well-diversified portfolio", () => {
    const insights = generatePortfolioConcentrationInsights([
      { symbol: "AAPL", currentValue: agorot(25_000) },
      { symbol: "MSFT", currentValue: agorot(25_000) },
      { symbol: "GOOGL", currentValue: agorot(25_000) },
      { symbol: "AMZN", currentValue: agorot(25_000) },
    ]);
    expect(insights).toHaveLength(0);
  });

  it("flags a single holding at 100% concentration", () => {
    const insights = generatePortfolioConcentrationInsights([{ symbol: "NVDA", currentValue: agorot(100_000) }]);
    expect(insights).toHaveLength(1);
    expect(insights[0].severity).toBe("critical");
  });

  it("returns nothing for an empty portfolio", () => {
    expect(generatePortfolioConcentrationInsights([])).toHaveLength(0);
  });
});
