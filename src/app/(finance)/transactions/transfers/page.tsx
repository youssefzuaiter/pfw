import Link from "next/link";
import { isPreselected } from "../../../../lib/transfer-matching";
import { getCurrentUser } from "../../../../server/auth/current-user";
import { listTransferMatches } from "../../../../server/dal/transfer-matches";
import { TransferMatchesPanel, type TransferMatchView } from "./_components/transfer-matches-panel";

export const instant = false;

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Transfers between your own accounts (AGENTS.md §3kkkk). Money that leaves one
 * account and arrives in another imports as spending in one and income in the
 * other, so every total counts it twice. This finds the two halves and, once you
 * confirm, marks both as a transfer, which every income and spending figure
 * leaves out. A sub-view reached from `/transactions`.
 */
export default async function TransfersPage() {
  const user = await getCurrentUser();
  const found = await listTransferMatches(user.id);

  const matches: TransferMatchView[] = found.map((match) => ({
    outId: match.out.id,
    inId: match.in.id,
    outAccount: match.out.accountLabel,
    inAccount: match.in.accountLabel,
    outLabel: match.out.label,
    inLabel: match.in.label,
    outDate: isoDate(match.out.occurredAt),
    inDate: isoDate(match.in.occurredAt),
    outCurrency: match.out.currency,
    inCurrency: match.in.currency,
    outNative: match.out.nativeAmount,
    inNative: match.in.nativeAmount,
    dayGap: match.dayGap,
    crossCurrency: match.crossCurrency,
    ambiguous: match.ambiguous,
    preselected: isPreselected(match),
  }));

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-4 md:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-fg">Transfers between your accounts</h1>
          <p className="mt-1 text-sm text-muted">
            Moving money between your own accounts is not income or spending. Mark both halves as a transfer and every total leaves them out. They stay in your list.
          </p>
        </div>
        <Link
          href="/transactions"
          className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted hover:bg-elevated-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          ← Transactions
        </Link>
      </div>
      <TransferMatchesPanel matches={matches} />
    </div>
  );
}
