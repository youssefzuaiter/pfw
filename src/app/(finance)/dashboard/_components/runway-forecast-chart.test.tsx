import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agorot } from "../../../../lib/money";

const runForecast = vi.fn();
vi.mock("../../../../workers/forecaster-client", () => ({ runForecast: (...args: unknown[]) => runForecast(...args) }));

import { RunwayForecastChart } from "./runway-forecast-chart";

/** 30 days, date 2026-12-01 .. 2026-12-30, ending at `medianAgorot`. */
function forecastEndingAt(medianAgorot: number) {
  return {
    days: Array.from({ length: 30 }, (_, i) => {
      const day = i + 1;
      const value = day === 30 ? medianAgorot : 0;
      return {
        dayIndex: day,
        date: `2026-12-${String(day).padStart(2, "0")}`,
        meanAgorot: value,
        p5Agorot: value - 1_000,
        p50Agorot: value,
        p95Agorot: value + 1_000,
      };
    }),
  };
}

const history = [{ dateKey: "2026-11-29", netAgorot: 30_000 }, { dateKey: "2026-11-30", netAgorot: 10_000 }];

describe("RunwayForecastChart: why it can differ from the 60-day forecast", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", class {});
    runForecast.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is labelled by what it assumes", async () => {
    runForecast.mockResolvedValue(forecastEndingAt(100_000));
    render(<RunwayForecastChart startingLiquidAgorot={agorot(72_100)} dailyHistory={history} knownDays={[]} />);
    expect(screen.getByRole("heading", { name: /if the last 90 days repeat/i })).toBeInTheDocument();
    expect(await screen.findByText(/does not know about specific bills coming due/i)).toBeInTheDocument();
  });

  it("explains a disagreement in direction, in money, with the income that causes it", async () => {
    runForecast.mockResolvedValue(forecastEndingAt(500_000));
    render(
      <RunwayForecastChart
        startingLiquidAgorot={agorot(72_100)}
        dailyHistory={history}
        knownDays={[{ date: "2026-12-30", balanceAgorot: -38_500 }]}
      />,
    );
    const note = await screen.findByRole("note");
    expect(note).toHaveTextContent("disagree on direction");
    expect(note).toHaveTextContent("-₪385.00");
    expect(note).toHaveTextContent("₪5,000.00");
    // The last 90 days averaged (30,000 + 10,000) / 2 = 200.00 a day coming in.
    expect(note).toHaveTextContent("+₪200.00");
    expect(note).toHaveTextContent("assumes no new income");
  });

  it("says nothing when the two forecasts agree", async () => {
    runForecast.mockResolvedValue(forecastEndingAt(80_000));
    render(
      <RunwayForecastChart
        startingLiquidAgorot={agorot(72_100)}
        dailyHistory={history}
        knownDays={[{ date: "2026-12-30", balanceAgorot: 79_000 }]}
      />,
    );
    await screen.findByText(/does not know about specific bills coming due/i);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("says nothing when the 60-day forecast has no matching day", async () => {
    runForecast.mockResolvedValue(forecastEndingAt(500_000));
    render(
      <RunwayForecastChart
        startingLiquidAgorot={agorot(72_100)}
        dailyHistory={history}
        knownDays={[{ date: "2027-02-01", balanceAgorot: -38_500 }]}
      />,
    );
    await screen.findByText(/does not know about specific bills coming due/i);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("describes a spending history differently from an income one", async () => {
    runForecast.mockResolvedValue(forecastEndingAt(-300_000));
    render(
      <RunwayForecastChart
        startingLiquidAgorot={agorot(72_100)}
        dailyHistory={[{ dateKey: "2026-11-30", netAgorot: -20_000 }]}
        knownDays={[{ date: "2026-12-30", balanceAgorot: 40_000 }]}
      />,
    );
    const note = await screen.findByRole("note");
    expect(note).toHaveTextContent("-₪200.00");
    expect(note).toHaveTextContent("without knowing about specific bills");
    expect(note).not.toHaveTextContent("assumes no new income");
  });
});
