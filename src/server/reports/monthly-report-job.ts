import "server-only";
import { monthKeyFor } from "../../lib/date-month";
import { createAdminClient } from "../db/admin-client";
import { claimMonthlyReport, releaseMonthlyReport } from "../dal/user-settings";
import { sendEmail } from "../email/resend-client";
import { getAppUrl } from "../env";
import { gatherMonthlyReport } from "./monthly-report";
import { renderMonthlyReport } from "./render-monthly-report";

/**
 * Sends the previous month's report to every user who opted in (AGENTS.md
 * §3lll), from the nightly GET /api/cron.
 *
 * Runs every night, not only on the 1st: a month is sent once, the first
 * night it can be, and `monthlyReportLastSentMonth` records it. The claim is
 * taken before the send and put back if the send fails, so a Resend outage
 * on the 1st is retried on the 2nd instead of losing the month.
 *
 * An admin-client exception (allowlisted), the inactivity-check shape: the
 * job has no session, and "who opted in, at what address" is a cross-user
 * read. That one query is all it does with the admin client; the claim, the
 * figures and the release go through the user-scoped DAL.
 */
export type MonthlyReportJobResult =
  | { ok: true; monthKey: string; sent: number; failed: number }
  | { ok: false; error: string };

type Candidate = { userId: string; email: string };

type Deps = {
  listCandidates: (monthKey: string) => Promise<Candidate[]>;
  claim: typeof claimMonthlyReport;
  release: typeof releaseMonthlyReport;
  gather: typeof gatherMonthlyReport;
  send: typeof sendEmail;
  appUrl: () => string;
};

/** The calendar month before the one `now` falls in, as `YYYY-MM` (UTC). */
export function previousMonthKey(now: Date): string {
  return monthKeyFor(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
}

async function listOptedInWithoutReport(monthKey: string): Promise<Candidate[]> {
  const admin = createAdminClient();
  const rows = await admin.userSettings.findMany({
    where: {
      monthlyReportEnabled: true,
      OR: [{ monthlyReportLastSentMonth: null }, { monthlyReportLastSentMonth: { not: monthKey } }],
    },
    select: { userId: true, user: { select: { email: true } } },
  });
  return rows.map((row) => ({ userId: row.userId, email: row.user.email }));
}

const defaultDeps: Deps = {
  listCandidates: listOptedInWithoutReport,
  claim: claimMonthlyReport,
  release: releaseMonthlyReport,
  gather: gatherMonthlyReport,
  send: sendEmail,
  appUrl: getAppUrl,
};

export async function sendMonthlyReports(now: Date = new Date(), deps: Deps = defaultDeps): Promise<MonthlyReportJobResult> {
  const monthKey = previousMonthKey(now);

  let candidates: Candidate[];
  try {
    candidates = await deps.listCandidates(monthKey);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  let sent = 0;
  let failed = 0;
  for (const { userId, email } of candidates) {
    const claim = await deps.claim(userId, monthKey).catch(() => ({ claimed: false as const }));
    if (!claim.claimed) continue;
    try {
      const report = renderMonthlyReport(await deps.gather(userId, monthKey), deps.appUrl());
      await deps.send({ to: email, ...report });
      sent += 1;
    } catch (error) {
      failed += 1;
      console.error(`monthly report for ${monthKey} failed for one user: ${error instanceof Error ? error.message : String(error)}`);
      await deps.release(userId, monthKey, claim.previous).catch(() => {});
    }
  }
  return { ok: true, monthKey, sent, failed };
}
