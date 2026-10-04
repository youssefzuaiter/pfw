import { describe, expect, it } from "vitest";
import {
  computeCoreAllocation,
  deriveCorePlans,
  findOpenPlan,
  parseStoredEntries,
  verifyJournalChain,
} from "../../src/lib/core-journal";
import { buildCoreMirrorSeed } from "./core-mirror";
import { SeededRng } from "./rng";

const NOW = new Date("2026-10-04T15:30:00Z");
const build = (seed = 42, now = NOW) => buildCoreMirrorSeed(now, new SeededRng(seed));

describe("buildCoreMirrorSeed", () => {
  it("is a real hash chain, so the page's own integrity check passes on it", () => {
    const seed = build();
    expect(verifyJournalChain(seed.entries)).toEqual({ ok: true, entries: seed.entries.length, head: seed.entries.at(-1)?.hash });
    expect(seed.chainId).toBe(seed.entries[0].hash);
    expect(seed.entries.length).toBeGreaterThan(10);
  });

  it("tells the story of one initial build that approved, filled and closed, then quiet weeks", () => {
    const seed = build();
    const entries = parseStoredEntries(seed.entries);
    expect(entries.slice(0, 3).map((e) => e.event)).toEqual(["started", "plan_accepted", "plan_approved"]);
    expect(entries.filter((e) => e.event === "order_submitted")).toHaveLength(6);
    expect(entries[9].event).toBe("plan_done");
    expect(entries.slice(10).every((e) => e.event === "no_plan")).toBe(true);

    const plans = deriveCorePlans(entries);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ id: seed.planId, kind: "initial", status: "done", fundedByOwner: true });
    expect(plans[0].orders).toHaveLength(6);
    expect(plans[0].orders.every((o) => o.status === "filled")).toBe(true);
    expect(findOpenPlan(plans)).toBeNull();
    // $9,999.00 spendable, less what truncating each nine-decimal quantity left unspent.
    expect(plans[0].tradedUsdCents).toBeGreaterThan(999_880);
    expect(plans[0].tradedUsdCents).toBeLessThanOrEqual(999_900);
  });

  it("keeps the entries in time order", () => {
    const times = parseStoredEntries(build().entries).map((e) => e.at.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(times.at(-1)).toBeLessThan(NOW.getTime());
  });

  it("builds an account that adds up, day by day, ending a couple of minutes ago", () => {
    const seed = build();
    const { snapshots } = seed;
    expect(snapshots.length).toBeGreaterThan(30);

    snapshots.forEach((snapshot, i) => {
      const invested = snapshot.positions.reduce((sum, p) => sum + p.marketValueUsdCents, 0);
      expect(snapshot.equityUsdCents).toBe(snapshot.cashUsdCents + invested);
      if (i > 0) {
        expect(snapshot.takenAt.getTime()).toBeGreaterThan(snapshots[i - 1].takenAt.getTime());
        expect(snapshot.lastEquityUsdCents).toBe(snapshots[i - 1].equityUsdCents);
      }
    });
    expect(snapshots[0].cashUsdCents).toBe(100); // the $1 reserve
    expect(Math.abs(snapshots[0].equityUsdCents - 1_000_000)).toBeLessThan(20); // priced at the fills, give or take rounding
    expect(snapshots.at(-1)?.takenAt).toEqual(new Date(NOW.getTime() - 2 * 60_000));
    expect(seed.reportedAt).toEqual(new Date(NOW.getTime() - 2 * 60_000));
  });

  it("holds the policy's mix, so the allocation table shows small drift rather than nonsense", () => {
    const last = build().snapshots.at(-1)!;
    const allocation = computeCoreAllocation({
      equityUsdCents: last.equityUsdCents,
      cashUsdCents: last.cashUsdCents,
      positions: last.positions,
      targets: last.targets,
    });
    expect(allocation.rows.map((r) => r.symbol).sort()).toEqual(["BIL", "BND", "IAU", "VNQ", "VTI", "VXUS"]);
    for (const row of allocation.rows) {
      expect(row.driftBps).not.toBeNull();
      expect(Math.abs(row.driftBps as number)).toBeLessThan(400); // within four points a month in
    }
  });

  it("is deterministic for a given seed and different for another", () => {
    expect(build(42)).toEqual(build(42));
    expect(build(43).snapshots.at(-1)?.equityUsdCents).not.toBe(build(42).snapshots.at(-1)?.equityUsdCents);
  });
});
