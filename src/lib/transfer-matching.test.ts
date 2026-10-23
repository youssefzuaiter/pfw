import { describe, expect, it } from "vitest";
import { findTransferMatches, isPreselected, MAX_DAY_GAP, type TransferCandidate } from "./transfer-matching";

let counter = 0;
function row(overrides: Partial<TransferCandidate> & { iso: string }): TransferCandidate {
  const { iso, ...rest } = overrides;
  counter++;
  return {
    id: `r${counter}`,
    accountId: "A",
    accountLabel: "Account A",
    occurredAt: new Date(`${iso}T12:00:00Z`),
    currency: "ILS",
    nativeAmount: -10_000,
    amountAgorot: -10_000,
    label: "x",
    ...rest,
  };
}
const out = (iso: string, extra: Partial<TransferCandidate> = {}) => row({ iso, accountId: "A", nativeAmount: -10_000, amountAgorot: -10_000, ...extra });
const inn = (iso: string, extra: Partial<TransferCandidate> = {}) => row({ iso, accountId: "B", nativeAmount: 10_000, amountAgorot: 10_000, ...extra });

describe("findTransferMatches", () => {
  it("pairs an expense with the equal income in another account", () => {
    const a = out("2026-09-03");
    const b = inn("2026-09-04");
    const matches = findTransferMatches([a, b]);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ dayGap: 1, crossCurrency: false, ambiguous: false });
    expect(matches[0].out.id).toBe(a.id);
    expect(matches[0].in.id).toBe(b.id);
    expect(isPreselected(matches[0])).toBe(true);
  });

  it("never pairs two rows of the same account", () => {
    expect(findTransferMatches([out("2026-09-03"), inn("2026-09-03", { accountId: "A" })])).toEqual([]);
  });

  it("needs the amounts to be exactly equal in one currency", () => {
    expect(findTransferMatches([out("2026-09-03"), inn("2026-09-03", { nativeAmount: 10_001, amountAgorot: 10_001 })])).toEqual([]);
  });

  it("pairs within the day window and not beyond it", () => {
    expect(findTransferMatches([out("2026-09-03"), inn(`2026-09-0${3 + MAX_DAY_GAP}`)])).toHaveLength(1);
    expect(findTransferMatches([out("2026-09-03"), inn(`2026-09-0${3 + MAX_DAY_GAP + 1}`)])).toEqual([]);
  });

  it("pairs when the income came first", () => {
    expect(findTransferMatches([inn("2026-09-02"), out("2026-09-03")])).toHaveLength(1);
  });

  it("counts days in UTC, not by hours", () => {
    const a = out("2026-09-03", { occurredAt: new Date("2026-09-03T23:59:00Z") });
    const b = inn("2026-09-04", { occurredAt: new Date("2026-09-04T00:01:00Z") });
    expect(findTransferMatches([a, b])[0].dayGap).toBe(1);
  });

  it("pairs lira out with dollars in by their shekel equivalents, within the tolerance", () => {
    const a = out("2026-09-03", { currency: "TRY", nativeAmount: -450_000, amountAgorot: -28_000 });
    const near = inn("2026-09-04", { currency: "USD", nativeAmount: 8_700, amountAgorot: 27_500 });
    const matches = findTransferMatches([a, near]);
    expect(matches).toHaveLength(1);
    expect(matches[0].crossCurrency).toBe(true);
    // Not as sure as one currency, so not ticked for the user.
    expect(isPreselected(matches[0])).toBe(false);
  });

  it("refuses a cross-currency pair outside the tolerance", () => {
    const a = out("2026-09-03", { currency: "TRY", nativeAmount: -450_000, amountAgorot: -28_000 });
    const far = inn("2026-09-04", { currency: "USD", nativeAmount: 9_900, amountAgorot: 31_000 });
    expect(findTransferMatches([a, far])).toEqual([]);
  });

  it("gives each row to the closest partner and marks a row with two possible partners as ambiguous", () => {
    const a = out("2026-09-03");
    const far = inn("2026-09-06", { id: "far" });
    const near = inn("2026-09-03", { id: "near" });
    const matches = findTransferMatches([a, far, near]);
    expect(matches).toHaveLength(1);
    expect(matches[0].in.id).toBe("near");
    expect(matches[0].ambiguous).toBe(true);
    expect(isPreselected(matches[0])).toBe(false);
  });

  it("pairs two identical transfers one to one", () => {
    const a1 = out("2026-09-03", { id: "a1" });
    const a2 = out("2026-09-03", { id: "a2" });
    const b1 = inn("2026-09-03", { id: "b1" });
    const b2 = inn("2026-09-03", { id: "b2" });
    const matches = findTransferMatches([a1, a2, b1, b2]);
    expect(matches).toHaveLength(2);
    expect(new Set(matches.flatMap((m) => [m.out.id, m.in.id])).size).toBe(4);
    expect(matches.every((m) => m.ambiguous)).toBe(true);
  });

  it("is deterministic whatever order the rows arrive in", () => {
    const rows = [out("2026-09-03", { id: "o1" }), inn("2026-09-03", { id: "i1" }), out("2026-09-10", { id: "o2" }), inn("2026-09-11", { id: "i2" })];
    const forward = findTransferMatches(rows).map((m) => [m.out.id, m.in.id]);
    const backward = findTransferMatches([...rows].reverse()).map((m) => [m.out.id, m.in.id]);
    expect(backward).toEqual(forward);
  });

  it("returns nothing for no rows or only one direction", () => {
    expect(findTransferMatches([])).toEqual([]);
    expect(findTransferMatches([out("2026-09-03"), out("2026-09-04", { accountId: "B" })])).toEqual([]);
  });
});
