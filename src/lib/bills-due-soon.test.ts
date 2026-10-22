import { describe, expect, it } from "vitest";
import { agorot } from "./money";
import { billsDueWithin } from "./bills-due-soon";
import type { PendingBill } from "./safe-to-spend";

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

function pending(key: string, name: string, dueIso: string, amount = 5_000): PendingBill {
  return {
    merchantKey: key,
    displayName: name,
    categoryId: null,
    occurrences: 1,
    amountEachAgorot: agorot(amount),
    totalAgorot: agorot(amount),
    dueDate: day(dueIso),
    overdue: false,
  };
}

const NOW = new Date("2026-10-30T09:00:00Z");

describe("billsDueWithin", () => {
  it("includes a bill due today and one due on the last day of the window", () => {
    const result = billsDueWithin([[pending("a", "Today", "2026-10-30"), pending("b", "Edge", "2026-11-02")]], NOW, 3);
    expect(result.map((bill) => bill.name)).toEqual(["Today", "Edge"]);
    expect(result.map((bill) => bill.daysAway)).toEqual([0, 3]);
  });

  it("leaves out a bill due after the window and one whose date has passed", () => {
    const result = billsDueWithin([[pending("a", "Later", "2026-11-03"), pending("b", "Passed", "2026-10-29")]], NOW, 3);
    expect(result).toEqual([]);
  });

  it("finds a bill due in next month by merging the two lists", () => {
    // The 30th: this month's list has nothing due on the 2nd; next month's does.
    const thisMonth = [pending("rent", "Rent", "2026-10-31")];
    const nextMonth = [pending("rent", "Rent", "2026-11-01"), pending("gym", "Gym", "2026-11-02")];
    const result = billsDueWithin([thisMonth, nextMonth], NOW, 3);
    expect(result.map((bill) => bill.key)).toEqual(["rent|2026-10-31", "rent|2026-11-01", "gym|2026-11-02"]);
  });

  it("keeps one entry per bill and due date even when both lists carry it", () => {
    const result = billsDueWithin([[pending("a", "Same", "2026-11-01")], [pending("a", "Same", "2026-11-01")]], NOW, 3);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe("a|2026-11-01");
  });

  it("sorts soonest first, then by name", () => {
    const result = billsDueWithin([[pending("c", "Zed", "2026-11-01"), pending("b", "Beta", "2026-10-31"), pending("a", "Alpha", "2026-11-01")]], NOW, 3);
    expect(result.map((bill) => bill.name)).toEqual(["Beta", "Alpha", "Zed"]);
  });

  it("carries the amount and the due day as text", () => {
    const [bill] = billsDueWithin([[pending("a", "Netflix", "2026-11-01", 4_990)]], NOW, 3);
    expect(bill).toMatchObject({ name: "Netflix", amountAgorot: 4_990, due: "2026-11-01" });
  });

  it("returns nothing for nothing", () => {
    expect(billsDueWithin([], NOW, 3)).toEqual([]);
    expect(billsDueWithin([[]], NOW, 3)).toEqual([]);
  });
});
