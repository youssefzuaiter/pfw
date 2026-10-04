import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { CorePlan } from "../../../lib/core-journal";
import { setCurrencyDisplayMode } from "../../../lib/hooks/use-currency-display-mode";
import type { CoreAccountView, CoreAgentData, CoreEventView } from "../../../server/core/build-core-agent-data";
import { CoreAllocationTable } from "./core-allocation-table";
import { CoreEmptyState, CoreUnavailable } from "./core-empty-state";
import { CoreJournalFeed } from "./core-journal-feed";
import { CoreOpenPlanCard } from "./core-plan-card";
import { CorePlanHistory } from "./core-plan-history";
import { CoreStatusCard } from "./core-status-card";

type Ready = Extract<CoreAgentData, { state: "ready" }>;

const NOW = new Date("2026-10-05T14:00:00Z");

function ready(over: Partial<Ready> = {}): Ready {
  return {
    state: "ready",
    now: NOW,
    freshness: { state: "fresh", ageSeconds: 180 },
    status: {
      reportedAt: new Date("2026-10-05T13:57:00Z"),
      tradingEnabled: true,
      disabledReason: null,
      halted: false,
      haltReason: null,
      policySha256: "4f3c".repeat(16),
      policyEffectiveFrom: "2026-10-05",
      plan: null,
      journal: { ok: true, entries: 6, reason: null },
      tickAgeSeconds: 4,
      tickFailures: 0,
      attention: [],
    },
    integrity: { ok: true, entries: 6, head: "a".repeat(64) },
    mirroredEntries: 6,
    chainCount: 1,
    plans: [],
    openPlan: null,
    events: [],
    hiddenEventCount: 0,
    account: null,
    ...over,
  };
}

function plan(over: Partial<CorePlan> = {}): CorePlan {
  return {
    id: "a1b2c3d4e5f60718",
    kind: "initial",
    status: "done",
    decidedOn: "2026-10-02",
    executeOn: "2026-10-05",
    redecision: false,
    reason: "initial",
    outcome: null,
    sells: [],
    buys: [
      { symbol: "BIL", notionalUsd: "499.95" },
      { symbol: "VTI", notionalUsd: "1899.81" },
    ],
    orders: [
      {
        clientOrderId: "core-a1-BIL-b",
        symbol: "BIL",
        side: "buy",
        status: "filled",
        notionalUsd: "499.95",
        qty: null,
        limitPrice: "93.73",
        filledQty: "5.4",
        filledAvgPrice: "91.00",
        error: null,
      },
    ],
    acceptedAt: new Date("2026-10-02T21:30:00Z"),
    approvedAt: new Date("2026-10-02T22:00:00Z"),
    closedAt: new Date("2026-10-05T13:45:00Z"),
    fundedByOwner: true,
    tradedUsdCents: 239_116,
    notes: [],
    problems: [],
    ...over,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("CoreStatusCard", () => {
  it("says a fresh, enabled router is reporting and trading, and its journal copy verified", () => {
    render(<CoreStatusCard data={ready()} />);
    expect(screen.getByText("Reporting · 3 min ago")).toBeInTheDocument();
    expect(screen.getByText("Trading enabled")).toBeInTheDocument();
    expect(screen.getByText(/Verified · 6 entries, hash chain intact/)).toBeInTheDocument();
    expect(screen.queryByText("Needs your attention")).not.toBeInTheDocument();
  });

  it("shows the kill switch and the router's attention items", () => {
    const data = ready({
      status: { ...ready().status!, halted: true, haltReason: "Emergency halt", attention: ["the kill switch is on: Emergency halt", "plan a1b2 is waiting for your signed approval"] },
    });
    render(<CoreStatusCard data={data} />);
    expect(screen.getByText("Kill switch on")).toBeInTheDocument();
    expect(screen.queryByText("Trading enabled")).not.toBeInTheDocument();
    const attention = screen.getByText("Needs your attention").parentElement as HTMLElement;
    expect(within(attention).getAllByRole("listitem")).toHaveLength(2);
  });

  it("shows a router that cannot trade as disabled", () => {
    render(<CoreStatusCard data={ready({ status: { ...ready().status!, tradingEnabled: false } })} />);
    expect(screen.getByText("Trading disabled")).toBeInTheDocument();
  });

  it.each([
    [{ state: "stale", ageSeconds: 7200 }, "Last report 2 h ago"],
    [{ state: "silent", ageSeconds: 3 * 86_400 }, "Silent for 3 d"],
    [{ state: "never", ageSeconds: null }, "Never reported"],
  ] as const)("describes a %j router without alarm or flattery", (freshness, text) => {
    render(<CoreStatusCard data={ready({ freshness: { ...freshness } })} />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it("says plainly when the stored copy of the journal does not verify, and where", () => {
    render(<CoreStatusCard data={ready({ integrity: { ok: false, atIndex: 2, reason: "the line does not hash to the entry's hash" } })} />);
    expect(screen.getByText(/Does not verify at entry 2: the line does not hash/)).toBeInTheDocument();
  });

  it("notes entries the router has that this copy has not yet received", () => {
    render(<CoreStatusCard data={ready({ mirroredEntries: 4 })} />);
    expect(screen.getByText(/2 newer on the router, not yet received/)).toBeInTheDocument();
  });

  it("says a policy that has not started yet starts later", () => {
    render(<CoreStatusCard data={ready({ status: { ...ready().status!, policyEffectiveFrom: "2026-10-12" } })} />);
    expect(screen.getByText("Starts 2026-10-12")).toBeInTheDocument();
  });

  it("renders whatever text the router sent as text, never as markup", () => {
    const hostile = `<img src=x onerror="document.title='pwned'">`;
    const { container } = render(<CoreStatusCard data={ready({ status: { ...ready().status!, attention: [hostile] } })} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(hostile)).toBeInTheDocument();
    expect(document.title).not.toBe("pwned");
  });

  it("explains a journal that arrived before any report", () => {
    render(<CoreStatusCard data={ready({ status: null, freshness: { state: "never", ageSeconds: null } })} />);
    expect(screen.getByText(/No report received yet/)).toBeInTheDocument();
  });
});

describe("CoreAllocationTable", () => {
  const account: CoreAccountView = {
    takenAt: new Date("2026-10-05T14:00:00Z"),
    ageSeconds: 30,
    equity: { usdCents: 1_000_000, ilsAgorot: 3_700_000 },
    cash: { usdCents: 100, ilsAgorot: 370 },
    invested: { usdCents: 999_900, ilsAgorot: 3_699_630 },
    dayChange: { usdCents: 1_000, ilsAgorot: 3_700, bps: 10 },
    usdIlsRate: 3.7,
    cashBps: 1,
    rows: [
      { symbol: "VTI", qty: "18.500000000", market: { usdCents: 200_000, ilsAgorot: 740_000 }, targetBps: 1900, actualBps: 2000, driftBps: 100 },
      { symbol: "VNQ", qty: "20.8", market: { usdCents: 180_000, ilsAgorot: 666_000 }, targetBps: 1900, actualBps: 1800, driftBps: -100 },
      { symbol: "BIL", qty: "0", market: { usdCents: 0, ilsAgorot: 0 }, targetBps: 500, actualBps: 0, driftBps: -500 },
      { symbol: "TSLA", qty: "1", market: null, targetBps: null, actualBps: null, driftBps: null },
    ],
  };

  it("shows each holding's share, its target and its drift in percentage points", () => {
    render(<CoreAllocationTable account={account} />);
    const vti = screen.getByRole("row", { name: /VTI/ });
    expect(within(vti).getByText("20.00%")).toBeInTheDocument();
    expect(within(vti).getByText("19.00%")).toBeInTheDocument();
    expect(within(vti).getByText("+1.00 pp")).toBeInTheDocument();
    expect(within(vti).getByText("18.5 sh")).toBeInTheDocument(); // trailing zeros trimmed
    expect(within(screen.getByRole("row", { name: /VNQ/ })).getByText("-1.00 pp")).toBeInTheDocument();
  });

  it("shows a target the account holds none of as zero against its target, and an unpriced holding without a figure", () => {
    render(<CoreAllocationTable account={account} />);
    expect(within(screen.getByRole("row", { name: /BIL/ })).getByText("-5.00 pp")).toBeInTheDocument();
    const tsla = screen.getByRole("row", { name: /TSLA/ });
    expect(within(tsla).getAllByText("—").length).toBeGreaterThanOrEqual(3);
  });

  it("leads with shekels by default and with dollars when the app-wide toggle says so", () => {
    const { unmount } = render(<CoreAllocationTable account={account} />);
    const [shekels] = within(screen.getByRole("row", { name: /VTI/ })).getAllByText(/[₪$]/);
    expect(shekels).toHaveTextContent("₪7,400.00");
    unmount();

    setCurrencyDisplayMode("native");
    render(<CoreAllocationTable account={account} />);
    const [dollars] = within(screen.getByRole("row", { name: /VTI/ })).getAllByText(/[₪$]/);
    expect(dollars).toHaveTextContent("$2,000.00");
  });

  it("offers the same holdings as a two-line list for a phone, with the drift on the second line", () => {
    render(<CoreAllocationTable account={account} />);
    const list = screen.getByRole("list", { name: "Holdings against the policy's target weights" });
    expect(within(list).getByText("20.00% of 19.00% target · +1.00 pp")).toBeInTheDocument();
    expect(within(list).getByText("18.5 sh")).toBeInTheDocument();
    expect(within(list).getByText("0.00% of 5.00% target · -5.00 pp")).toBeInTheDocument();
    expect(within(list).getByText("Cash · 0.01%")).toBeInTheDocument();
    expect(within(list).getByText("Equity")).toBeInTheDocument();
  });

  it("closes with the account's cash and equity", () => {
    render(<CoreAllocationTable account={account} />);
    expect(screen.getByRole("row", { name: /^Cash/ })).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: /^Equity/ })).getByText("₪37,000.00")).toBeInTheDocument();
  });
});

describe("CoreOpenPlanCard", () => {
  it("says no plan is open when none is", () => {
    render(<CoreOpenPlanCard plan={null} />);
    expect(screen.getByText(/No plan is open/)).toBeInTheDocument();
  });

  it("tells the owner an initial build is waiting, and how to approve it — this page cannot", () => {
    render(<CoreOpenPlanCard plan={plan({ status: "awaiting_approval", orders: [], closedAt: null, tradedUsdCents: null })} />);
    expect(screen.getByText("Waiting for your approval")).toBeInTheDocument();
    expect(screen.getByText("core_ctl approve")).toBeInTheDocument();
    expect(screen.getByText("--fund")).toBeInTheDocument();
    expect(screen.getByText(/this page cannot, by design/)).toBeInTheDocument();
    expect(screen.getAllByText(/^Buy/, { selector: "li" })).toHaveLength(2);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("does not ask for the fund flag on a rebalance", () => {
    render(<CoreOpenPlanCard plan={plan({ kind: "rebalance", status: "awaiting_approval", orders: [] })} />);
    expect(screen.queryByText("--fund")).not.toBeInTheDocument();
  });

  it("shows the orders of a plan that is trading", () => {
    render(<CoreOpenPlanCard plan={plan({ status: "buying" })} />);
    expect(screen.getByText("Buying")).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("5.4 sh @ $91.00")).toBeInTheDocument();
  });
});

describe("CorePlanHistory", () => {
  const older = plan({ id: "0f9e8d7c6b5a4321", kind: "rebalance", executeOn: "2026-12-31", status: "abandoned", outcome: "still buying at 15:30 New York", tradedUsdCents: 12_345 });
  const newer = plan();

  it("lists closed plans newest first, opens the newest, and leaves the open plan to its own card", () => {
    const open = plan({ id: "ffffffffffffffff", status: "awaiting_approval", executeOn: "2027-03-31" });
    const { container } = render(<CorePlanHistory plans={[older, newer, open]} openPlan={open} />);
    const items = Array.from(screen.getByRole("list", { name: "Closed plans, newest first" }).children) as HTMLElement[];
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText("2026-10-05")).toBeInTheDocument(); // the newer closed one first
    expect(within(items[1]).getByText("2026-12-31")).toBeInTheDocument();
    const details = container.querySelectorAll("details");
    expect(details[0]).toHaveAttribute("open");
    expect(details[1]).not.toHaveAttribute("open");
    expect(screen.queryByText(/ffffffff/)).not.toBeInTheDocument();
  });

  it("shows what each plan traded and why an unfinished one ended", () => {
    render(<CorePlanHistory plans={[older, newer]} openPlan={null} />);
    expect(screen.getByText("$2,391.16 traded")).toBeInTheDocument();
    expect(screen.getByText("$123.45 traded")).toBeInTheDocument();
    expect(screen.getByText("still buying at 15:30 New York")).toBeInTheDocument();
    expect(screen.getByText("Abandoned")).toBeInTheDocument();
  });

  it("says so when nothing has closed yet", () => {
    render(<CorePlanHistory plans={[]} openPlan={null} />);
    expect(screen.getByText("No plan has closed yet.")).toBeInTheDocument();
  });

  it("lists a rejected plan's problems", () => {
    render(<CorePlanHistory plans={[plan({ status: "rejected", problems: ["turnover 31% is over the 25% cap"], orders: [], tradedUsdCents: 0 })]} openPlan={null} />);
    expect(screen.getByText("turnover 31% is over the 25% cap")).toBeInTheDocument();
  });
});

describe("CoreJournalFeed", () => {
  const event = (index: number, over: Partial<CoreEventView> = {}): CoreEventView => ({
    index,
    hash: `${String(index).padStart(2, "0")}`.repeat(32),
    at: new Date(`2026-10-05T13:0${index}:00Z`),
    planId: null,
    label: `Event ${index}`,
    detail: null,
    tone: "neutral",
    ...over,
  });

  it("lists entries with their time, label, detail and short hash", () => {
    render(<CoreJournalFeed events={[event(1, { label: "Plan a1b2c3d4 done", detail: "2 orders filled", tone: "positive" }), event(0)]} hiddenCount={0} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText("Plan a1b2c3d4 done")).toBeInTheDocument();
    expect(within(items[0]).getByText("2 orders filled")).toBeInTheDocument();
    expect(within(items[0]).getByText("Oct 5, 2026, 13:01 UTC")).toBeInTheDocument();
    expect(within(items[0]).getByText("#1 · 01010101")).toBeInTheDocument();
  });

  it("counts the entries it is not showing", () => {
    render(<CoreJournalFeed events={[event(1)]} hiddenCount={10} />);
    expect(screen.getByText("10 earlier entries are not shown.")).toBeInTheDocument();
  });

  it("says when the journal is empty", () => {
    render(<CoreJournalFeed events={[]} hiddenCount={0} />);
    expect(screen.getByText("The journal is empty.")).toBeInTheDocument();
  });

  it("renders a hostile detail as text", () => {
    const hostile = `<script>alert(1)</script>`;
    const { container } = render(<CoreJournalFeed events={[event(0, { detail: hostile, tone: "critical" })]} hiddenCount={0} />);
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText(hostile)).toBeInTheDocument();
  });
});

describe("the pages with nothing to show", () => {
  it("tells an account the router has never reported to how to connect one, and that nothing is lost meanwhile", () => {
    render(<CoreEmptyState />);
    expect(screen.getByText("Not connected yet")).toBeInTheDocument();
    expect(screen.getByText("CORE_PFW_SYNC_URL")).toBeInTheDocument();
    expect(screen.getByText("/api/webhooks/core")).toBeInTheDocument();
    expect(screen.getByText(/Nothing is lost while it is not connected/)).toBeInTheDocument();
  });

  it("tells the operator of a deployment whose migration has not run which migration it is", () => {
    render(<CoreUnavailable />);
    expect(screen.getByText("Not set up on this deployment")).toBeInTheDocument();
    expect(screen.getByText("core_agent_mirror")).toBeInTheDocument();
    expect(screen.getByText(/nothing is lost/)).toBeInTheDocument();
  });
});
