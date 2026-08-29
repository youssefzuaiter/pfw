import { Badge, type BadgeVariant } from "../../components/badge/badge";
import { Tickbar, type TickbarStatus } from "../../components/tickbar/tickbar";
import { summarizeGoalProgress, type GoalProgressStatus } from "../../lib/goal-progress";
import { agorot, formatAgorot } from "../../lib/money";
import { getCurrentUser } from "../../server/auth/current-user";
import { listGoals } from "../../server/dal/goals";
import { getZkVaultStatus } from "../../server/dal/zk-vault";
import { AddContributionForm } from "./_components/add-contribution-form";
import { ContributionNote } from "./_components/contribution-note";
import { CreateGoalForm } from "./_components/create-goal-form";
import { SecureNotesPanel } from "./_components/secure-notes-panel";

export const instant = false;

const STATUS_LABEL: Record<GoalProgressStatus, string> = {
  complete: "Goal reached",
  no_target_date: "No target date set",
  overdue: "Past target date",
  ahead: "Ahead of pace",
  on_track: "On track",
  behind: "Behind pace",
};

const STATUS_TICKBAR: Record<GoalProgressStatus, TickbarStatus> = {
  complete: "good",
  no_target_date: "good",
  overdue: "critical",
  ahead: "good",
  on_track: "good",
  behind: "warning",
};

const STATUS_BADGE: Record<GoalProgressStatus, BadgeVariant> = {
  complete: "positive",
  no_target_date: "neutral",
  overdue: "critical",
  ahead: "positive",
  on_track: "positive",
  behind: "warning",
};

export default async function GoalsPage() {
  const user = await getCurrentUser();
  const [goals, zkVaultStatus] = await Promise.all([listGoals(user.id), getZkVaultStatus(user.id)]);
  const now = new Date();

  // Only counts, never plaintext or ciphertext content — see
  // ContributionNote for where each note's raw ciphertext actually flows
  // (as an opaque prop the server never inspects).
  const legacyNoteCount = goals.reduce(
    (sum, goal) => sum + goal.contributions.filter((c) => c.note && !c.note.startsWith("zk1:")).length,
    0,
  );

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 md:px-6">
      <h1 className="font-display text-2xl font-semibold text-fg">Goals</h1>

      <SecureNotesPanel
        isSetUp={zkVaultStatus.isSetUp}
        salt={zkVaultStatus.salt}
        iterations={zkVaultStatus.iterations}
        canaryCiphertext={zkVaultStatus.canaryCiphertext}
        legacyNoteCount={legacyNoteCount}
      />

      <section className="rounded-lg border border-border bg-surface p-4">
        <CreateGoalForm />
      </section>

      {goals.length === 0 && <p className="text-sm text-muted">No goals yet — add one above.</p>}

      <ul className="flex flex-col gap-4">
        {goals.map((goal) => {
          const targetAmount = agorot(Number(goal.targetAmount));
          const currentAmount = agorot(goal.contributions.reduce((sum, c) => sum + Number(c.amount), 0));
          const summary = summarizeGoalProgress({
            targetAmount,
            currentAmount,
            startDate: goal.createdAt,
            targetDate: goal.targetDate ?? undefined,
            today: now,
          });

          return (
            <li key={goal.id} className="rounded-lg border border-border bg-surface p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="flex flex-wrap items-center gap-2 font-medium text-fg">
                    {goal.name}
                    <Badge variant={STATUS_BADGE[summary.status]} pulse={summary.status === "overdue"}>
                      {STATUS_LABEL[summary.status]}
                    </Badge>
                  </p>
                  <p className="font-tabular-figures text-sm text-muted">
                    {formatAgorot(currentAmount)} of {formatAgorot(targetAmount)}
                  </p>
                </div>
                <AddContributionForm goalId={goal.id} />
              </div>
              <div className="mt-3">
                <Tickbar
                  label={`${goal.name} progress`}
                  percent={summary.progressPercent}
                  status={STATUS_TICKBAR[summary.status]}
                />
              </div>
              {summary.projectedCompletionDate && summary.status !== "complete" && (
                <p className="mt-2 text-xs text-muted">
                  Projected completion around {summary.projectedCompletionDate.toISOString().slice(0, 10)}
                </p>
              )}
              {goal.contributions.length > 0 && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs font-medium text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    Contribution log ({goal.contributions.length})
                  </summary>
                  <ul className="mt-2 flex flex-col gap-1">
                    {[...goal.contributions]
                      .sort((a, b) => b.contributedAt.getTime() - a.contributedAt.getTime())
                      .map((contribution) => (
                        <li key={contribution.id} className="flex flex-wrap justify-between gap-x-3 text-xs text-muted">
                          <span>{contribution.contributedAt.toISOString().slice(0, 10)}</span>
                          <ContributionNote ciphertext={contribution.note} />
                          <span className="font-tabular-figures">{formatAgorot(agorot(Number(contribution.amount)))}</span>
                        </li>
                      ))}
                  </ul>
                </details>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
