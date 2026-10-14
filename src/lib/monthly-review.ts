/**
 * The arithmetic behind the monthly review page (AGENTS.md §3ppp). Pure, so
 * it is tested with plain numbers; amounts stay integer agorot (law #1).
 */

export type Change = {
  /** current − previous, in agorot. */
  deltaAgorot: bigint;
  /** The change as basis points of `previous`, or null when `previous` is 0 (a change from nothing has no percentage). */
  bps: number | null;
};

export function changeFrom(previous: bigint, current: bigint): Change {
  const deltaAgorot = current - previous;
  if (previous === 0n) return { deltaAgorot, bps: null };
  const magnitude = previous < 0n ? -previous : previous;
  // Half away from zero, in integer arithmetic.
  const scaled = deltaAgorot * 10_000n;
  const half = magnitude / 2n;
  const bps = scaled >= 0n ? (scaled + half) / magnitude : -((-scaled + half) / magnitude);
  return { deltaAgorot, bps: Number(bps) };
}

/** "+12.5%" / "-3.0%" / "0.0%" from basis points. */
export function formatBpsChange(bps: number): string {
  const sign = bps > 0 ? "+" : bps < 0 ? "-" : "";
  return `${sign}${(Math.abs(bps) / 100).toFixed(1)}%`;
}

export type CategoryShare = { name: string; spentAgorot: bigint; percent: number };

/** Each category's share of the month's spending, largest first. Percent of the categories' own total, so the shares add up to 100. */
export function spendingShares(categories: readonly { name: string; spentAgorot: bigint }[]): CategoryShare[] {
  const total = categories.reduce((sum, category) => sum + category.spentAgorot, 0n);
  return [...categories]
    .sort((a, b) => (b.spentAgorot > a.spentAgorot ? 1 : b.spentAgorot < a.spentAgorot ? -1 : a.name.localeCompare(b.name)))
    .map((category) => ({
      ...category,
      percent: total === 0n ? 0 : Number((category.spentAgorot * 10_000n) / total) / 100,
    }));
}
