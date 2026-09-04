import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "../../../../../server/auth/current-user";
import { checkRateLimit } from "../../../../../server/api/rate-limit";
import { jsonNotFound, jsonServerError, jsonTooManyRequests } from "../../../../../server/api/responses";
import { getLedgerHistory, verifyLedgerChain } from "../../../../../server/dal/ledger-commits";
import { getTransactionById } from "../../../../../server/dal/transactions";

/**
 * Cryptographic Ledger Versioning (ad hoc) — a GET, read-only endpoint
 * over one transaction's own hash-chained history. No mutation, no
 * rollback: scoped down from an originally-requested rollback engine
 * after a real architecture conflict was raised and confirmed with the
 * user (see prisma/schema.prisma's LedgerCommit model doc comment for
 * the full reasoning). Deliberately skips `guardMutation`'s Origin/CSRF
 * check — nothing changes state — but keeps identity resolution and
 * rate limiting by calling those primitives directly, same pattern as
 * `GET /api/tax/simulate` and `GET /api/analytics/monte-carlo`.
 */
const RATE_LIMIT = { windowMs: 60_000, maxRequests: 30 };

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();

  const rate = checkRateLimit(`transactions:ledger:${user.id}`, RATE_LIMIT);
  if (!rate.allowed) {
    return jsonTooManyRequests(rate.resetAt);
  }

  const { id } = await params;

  try {
    // "Not found" covers both "doesn't exist" and "belongs to someone
    // else" — an IDOR attempt must never get a distinguishable response
    // (Section 2.2). getLedgerHistory/verifyLedgerChain are already
    // userId-scoped via RLS on their own, but checking ownership
    // explicitly first is what lets a wrong transactionId return a real
    // 404 instead of a confusing "200 with zero commits."
    const transaction = await getTransactionById(user.id, id);
    if (!transaction) {
      return jsonNotFound();
    }

    const [commits, verification] = await Promise.all([
      getLedgerHistory(user.id, id),
      verifyLedgerChain(user.id, id),
    ]);

    return NextResponse.json({
      commits: commits.map((commit) => ({
        id: commit.id,
        action: commit.action,
        previousHash: commit.previousHash,
        currentHash: commit.currentHash,
        patchData: commit.patchData,
        createdAtIso: commit.createdAt.toISOString(),
      })),
      chainValid: verification.valid,
      brokenAtCommitId: verification.brokenAtCommitId,
    });
  } catch (error) {
    console.error("GET /api/transactions/[id]/ledger failed", error);
    return jsonServerError();
  }
}
