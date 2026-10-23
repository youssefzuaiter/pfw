import type { CurrencyCode } from "./currency";

/**
 * Finds the two halves of a transfer between the user's own accounts (AGENTS.md
 * §3kkkk): money leaves account A and arrives in account B a day or two later,
 * and both rows import as ordinary spending and income, so the same money is
 * counted twice. Pure: the caller supplies the rows.
 *
 * A pair is one expense and one income, in DIFFERENT accounts, within
 * `MAX_DAY_GAP` days of each other, for the same amount:
 *   - same currency: the entered amounts are equal, exactly;
 *   - different currencies (lira out, dollars in): the frozen shekel equivalents
 *     are within `CROSS_CURRENCY_TOLERANCE_BPS`, because a bank's own rate
 *     and spread never match the stored one exactly.
 *
 * A match is a proposal, never a fact: a rent payment and a friend's repayment
 * of the same amount can look identical. So each match says whether it is
 * `ambiguous` (either half could pair with more than one row), and the screen
 * only pre-ticks the clear same-currency ones.
 */

export const MAX_DAY_GAP = 3;
export const CROSS_CURRENCY_TOLERANCE_BPS = 300;

export type TransferCandidate = {
  id: string;
  accountId: string;
  accountLabel: string;
  occurredAt: Date;
  currency: CurrencyCode;
  /** Signed, minor units of `currency`: negative is money out. */
  nativeAmount: number;
  /** Signed ILS agorot, as stored with the row. */
  amountAgorot: number;
  label: string;
};

export type TransferMatch = {
  out: TransferCandidate;
  in: TransferCandidate;
  /** Whole UTC days between the two rows. */
  dayGap: number;
  crossCurrency: boolean;
  /** Either half had more than one possible partner. */
  ambiguous: boolean;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const utcDay = (date: Date): number => Math.floor(date.getTime() / MS_PER_DAY);

type Edge = { out: TransferCandidate; in: TransferCandidate; gap: number; mismatchBps: number; crossCurrency: boolean };

function edgeBetween(out: TransferCandidate, incoming: TransferCandidate): Edge | null {
  if (out.accountId === incoming.accountId) return null;
  const gap = Math.abs(utcDay(out.occurredAt) - utcDay(incoming.occurredAt));
  if (gap > MAX_DAY_GAP) return null;

  if (out.currency === incoming.currency) {
    if (Math.abs(out.nativeAmount) !== incoming.nativeAmount) return null;
    return { out, in: incoming, gap, mismatchBps: 0, crossCurrency: false };
  }

  const a = Math.abs(out.amountAgorot);
  const b = Math.abs(incoming.amountAgorot);
  if (a === 0 || b === 0) return null;
  const mismatchBps = Math.round((Math.abs(a - b) * 10_000) / Math.max(a, b));
  if (mismatchBps > CROSS_CURRENCY_TOLERANCE_BPS) return null;
  return { out, in: incoming, gap, mismatchBps, crossCurrency: true };
}

export function findTransferMatches(candidates: readonly TransferCandidate[]): TransferMatch[] {
  const outs = candidates.filter((row) => row.nativeAmount < 0);
  const ins = candidates
    .filter((row) => row.nativeAmount > 0)
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id));

  // Every possible pairing. Incomes are sorted by time, so only the ones within
  // the day window of each expense are looked at.
  const windowMs = (MAX_DAY_GAP + 1) * MS_PER_DAY;
  const edges: Edge[] = [];
  let start = 0;
  for (const out of [...outs].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())) {
    while (start < ins.length && ins[start].occurredAt.getTime() < out.occurredAt.getTime() - windowMs) start++;
    for (let i = start; i < ins.length && ins[i].occurredAt.getTime() <= out.occurredAt.getTime() + windowMs; i++) {
      const edge = edgeBetween(out, ins[i]);
      if (edge) edges.push(edge);
    }
  }

  const options = new Map<string, number>();
  for (const edge of edges) {
    options.set(edge.out.id, (options.get(edge.out.id) ?? 0) + 1);
    options.set(edge.in.id, (options.get(edge.in.id) ?? 0) + 1);
  }

  // Closest pairs first, so a row is never taken by a worse partner when a
  // nearer one exists; each row joins at most one pair.
  edges.sort((a, b) => a.gap - b.gap || a.mismatchBps - b.mismatchBps || a.out.id.localeCompare(b.out.id) || a.in.id.localeCompare(b.in.id));
  const used = new Set<string>();
  const matches: TransferMatch[] = [];
  for (const edge of edges) {
    if (used.has(edge.out.id) || used.has(edge.in.id)) continue;
    used.add(edge.out.id);
    used.add(edge.in.id);
    matches.push({
      out: edge.out,
      in: edge.in,
      dayGap: edge.gap,
      crossCurrency: edge.crossCurrency,
      ambiguous: (options.get(edge.out.id) ?? 0) > 1 || (options.get(edge.in.id) ?? 0) > 1,
    });
  }

  return matches.sort((a, b) => a.out.occurredAt.getTime() - b.out.occurredAt.getTime() || a.out.id.localeCompare(b.out.id));
}

/** Whether the screen should tick a match for the user: clear and in one currency. */
export function isPreselected(match: TransferMatch): boolean {
  return !match.ambiguous && !match.crossCurrency;
}
