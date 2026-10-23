import { describe, expect, it } from "vitest";
import { buildMonthCalendar, expectedDates, type CalendarCharge, type CalendarItem } from "./bill-calendar";

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

function manual(overrides: Partial<CalendarItem> = {}): CalendarItem {
  return {
    key: "manual:1",
    name: "Electricity",
    currency: "ILS",
    nativeAmount: 30_000,
    schedule: { kind: "anchor", cadence: "monthly", anchorDate: day("2026-07-25") },
    cancelled: false,
    ...overrides,
  };
}

function seen(overrides: Partial<CalendarItem> = {}, lastSeen = "2026-09-20", cadence: "weekly" | "monthly" | "quarterly" | "annual" = "monthly"): CalendarItem {
  return {
    key: "streamflix",
    name: "Streamflix",
    currency: "ILS",
    nativeAmount: 3_990,
    schedule: { kind: "seen", cadence, lastSeenAt: day(lastSeen), averageIntervalDays: null },
    cancelled: false,
    ...overrides,
  };
}

const charge = (itemKey: string, name: string, iso: string, nativeAmount: number): CalendarCharge => ({ itemKey, name, currency: "ILS", nativeAmount, date: day(iso) });

function entriesOn(calendar: ReturnType<typeof buildMonthCalendar>, iso: string) {
  return calendar.days.find((d) => d.date === iso)?.entries ?? [];
}

describe("buildMonthCalendar", () => {
  const today = day("2026-10-16");

  it("lays out the month: every day, the weekday of the 1st, and the neighbouring months", () => {
    const calendar = buildMonthCalendar({ monthKey: "2026-10", items: [], charges: [], today });
    expect(calendar.days).toHaveLength(31);
    expect(calendar.monthLabel).toBe("October 2026");
    expect(calendar.previousMonthKey).toBe("2026-09");
    expect(calendar.nextMonthKey).toBe("2026-11");
    // 1 October 2026 is a Thursday: three blanks on a Monday-first week.
    expect(calendar.leadingBlanks).toBe(3);
    expect(calendar.days.filter((d) => d.isToday).map((d) => d.date)).toEqual(["2026-10-16"]);
    expect(buildMonthCalendar({ monthKey: "2026-02", items: [], charges: [], today }).days).toHaveLength(28);
    expect(buildMonthCalendar({ monthKey: "2028-02", items: [], charges: [], today }).days).toHaveLength(29);
    expect(buildMonthCalendar({ monthKey: "2026-12", items: [], charges: [], today }).nextMonthKey).toBe("2027-01");
  });

  it("shows a charge still to come as due, and one whose day has passed without a charge as not charged yet", () => {
    const calendar = buildMonthCalendar({
      monthKey: "2026-10",
      items: [manual({ schedule: { kind: "anchor", cadence: "monthly", anchorDate: day("2026-07-25") } }), manual({ key: "manual:2", name: "Water", schedule: { kind: "anchor", cadence: "monthly", anchorDate: day("2026-07-03") } })],
      charges: [],
      today,
    });
    expect(entriesOn(calendar, "2026-10-25")).toEqual([expect.objectContaining({ name: "Electricity", state: "due" })]);
    expect(entriesOn(calendar, "2026-10-03")).toEqual([expect.objectContaining({ name: "Water", state: "not-charged" })]);
    expect(calendar.counts).toEqual({ paid: 0, due: 1, notCharged: 1 });
  });

  it("a charge found in the ledger shows as paid on its own day and replaces the expected one", () => {
    const calendar = buildMonthCalendar({
      monthKey: "2026-10",
      items: [manual()],
      charges: [charge("manual:1", "ELECTRICITY CO", "2026-10-13", 30_500)],
      today,
    });
    expect(entriesOn(calendar, "2026-10-13")).toEqual([expect.objectContaining({ name: "ELECTRICITY CO", nativeAmount: 30_500, state: "paid" })]);
    expect(entriesOn(calendar, "2026-10-25")).toEqual([]);
    expect(calendar.counts).toEqual({ paid: 1, due: 0, notCharged: 0 });
  });

  it("only this month's charges appear", () => {
    const calendar = buildMonthCalendar({
      monthKey: "2026-10",
      items: [],
      charges: [charge("manual:1", "Electricity", "2026-09-30", 30_000), charge("manual:1", "Electricity", "2026-11-01", 30_000)],
      today,
    });
    expect(calendar.counts).toEqual({ paid: 0, due: 0, notCharged: 0 });
  });

  it("a cancelled item has nothing expected, but a charge it already had still shows", () => {
    const calendar = buildMonthCalendar({
      monthKey: "2026-10",
      items: [manual({ cancelled: true })],
      charges: [charge("manual:1", "Electricity", "2026-10-02", 30_000)],
      today,
    });
    expect(calendar.counts).toEqual({ paid: 1, due: 0, notCharged: 0 });
  });

  it("a quarterly bill appears only in the months it is due, and a yearly one only once a year", () => {
    const quarterly = manual({ schedule: { kind: "anchor", cadence: "quarterly", anchorDate: day("2026-07-10") } });
    const total = (monthKey: string, item: CalendarItem) => {
      const c = buildMonthCalendar({ monthKey, items: [item], charges: [], today }).counts;
      return c.due + c.notCharged;
    };
    // July, October and January: every three months from the anchor.
    expect(["2026-08", "2026-09", "2026-10", "2026-11", "2026-12", "2027-01"].map((m) => total(m, quarterly))).toEqual([0, 0, 1, 0, 0, 1]);
    const yearly = manual({ schedule: { kind: "anchor", cadence: "annual", anchorDate: day("2026-03-15") } });
    expect([total("2027-03", yearly), total("2027-04", yearly), total("2028-03", yearly)]).toEqual([1, 0, 1]);
  });

  it("a day that does not exist in the month falls on its last day", () => {
    const item = manual({ schedule: { kind: "anchor", cadence: "monthly", anchorDate: day("2026-07-31") } });
    const calendar = buildMonthCalendar({ monthKey: "2026-11", items: [item], charges: [], today });
    expect(entriesOn(calendar, "2026-11-30")).toHaveLength(1);
  });

  it("projects a subscription seen in the statements forward by its cycle", () => {
    const monthly = seen();
    expect(entriesOn(buildMonthCalendar({ monthKey: "2026-10", items: [monthly], charges: [], today }), "2026-10-20")).toEqual([expect.objectContaining({ name: "Streamflix", state: "due" })]);
    expect(entriesOn(buildMonthCalendar({ monthKey: "2026-11", items: [monthly], charges: [], today }), "2026-11-20")).toHaveLength(1);
    // The month it was last seen in, and earlier ones, show nothing expected.
    expect(buildMonthCalendar({ monthKey: "2026-09", items: [monthly], charges: [], today }).counts).toEqual({ paid: 0, due: 0, notCharged: 0 });
  });

  it("does not project a subscription that stopped, or one seen less than a cycle ago twice over", () => {
    const stopped = seen({}, "2026-05-20");
    expect(buildMonthCalendar({ monthKey: "2026-11", items: [stopped], charges: [], today }).counts).toEqual({ paid: 0, due: 0, notCharged: 0 });
    const quarterly = seen({}, "2026-08-20", "quarterly");
    expect(expectedDates(quarterly, 2026, 10, today).map((d) => d.toISOString().slice(0, 10))).toEqual(["2026-11-20"]);
    expect(expectedDates(quarterly, 2026, 9, today)).toEqual([]);
  });

  it("a weekly item shows every expected week, and only those after a charge it already had", () => {
    const weekly = seen({ schedule: { kind: "seen", cadence: "weekly", lastSeenAt: day("2026-10-06"), averageIntervalDays: 7 } });
    const dates = (charges: CalendarCharge[]) =>
      buildMonthCalendar({ monthKey: "2026-10", items: [weekly], charges, today })
        .days.filter((d) => d.entries.some((e) => e.state !== "paid"))
        .map((d) => d.date);
    expect(dates([])).toEqual(["2026-10-13", "2026-10-20", "2026-10-27"]);
    expect(dates([charge("streamflix", "Streamflix", "2026-10-13", 3_990)])).toEqual(["2026-10-20", "2026-10-27"]);
  });

  it("keeps each charge in its own currency", () => {
    const calendar = buildMonthCalendar({
      monthKey: "2026-10",
      items: [],
      charges: [{ itemKey: "x", name: "Cloud", currency: "USD", nativeAmount: 999, date: day("2026-10-04") }],
      today,
    });
    expect(entriesOn(calendar, "2026-10-04")).toEqual([expect.objectContaining({ currency: "USD", nativeAmount: 999 })]);
  });
});
