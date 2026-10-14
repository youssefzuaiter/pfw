import "server-only";
import { composePhoneAlert, evaluatePhoneAlerts } from "../../lib/phone-alerts";
import { createAdminClient } from "../db/admin-client";
import { gatherPhoneAlertFacts, getPhoneAlertDelivery, savePhoneAlertState } from "../dal/phone-alerts";
import { getAppUrl, getOperatorAlertEmail } from "../env";
import { sendNtfy, type NtfyMessage } from "./ntfy-client";

/**
 * The nightly phone-alert check (AGENTS.md §3qqq), from GET /api/cron after
 * the Emergency Vault check, so a grace-period notice written tonight goes
 * out tonight.
 *
 * An admin-client exception (allowlisted), the snapshot-job shape: "who has
 * alerts on" is a cross-user read with no session. It selects user ids only
 * — never the topic — and everything after that goes through the scoped DAL.
 *
 * The state moves only after a successful send (or when there was nothing
 * to send), so an ntfy.sh outage repeats tonight's alerts tomorrow rather
 * than losing them. One user's failure is counted, never fatal.
 */
export type PhoneAlertJobResult = { ok: true; checked: number; sent: number; failed: number } | { ok: false; error: string };

type Deps = {
  listSubscribers: () => Promise<string[]>;
  getDelivery: typeof getPhoneAlertDelivery;
  gather: typeof gatherPhoneAlertFacts;
  saveState: typeof savePhoneAlertState;
  send: typeof sendNtfy;
  appUrl: () => string;
};

async function listSubscribers(): Promise<string[]> {
  const admin = createAdminClient();
  const rows = await admin.phoneAlertSubscription.findMany({ select: { userId: true } });
  return rows.map((row) => row.userId);
}

const defaultDeps: Deps = {
  listSubscribers,
  getDelivery: getPhoneAlertDelivery,
  gather: gatherPhoneAlertFacts,
  saveState: savePhoneAlertState,
  send: sendNtfy,
  appUrl: getAppUrl,
};

export async function sendPhoneAlerts(now: Date = new Date(), deps: Deps = defaultDeps): Promise<PhoneAlertJobResult> {
  let userIds: string[];
  try {
    userIds = await deps.listSubscribers();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  let sent = 0;
  let failed = 0;
  for (const userId of userIds) {
    try {
      const delivery = await deps.getDelivery(userId);
      if (!delivery) continue; // turned off since the list was read

      const facts = await deps.gather(userId, { since: delivery.state.lastCheckedAt, now, largeExpenseAgorot: delivery.largeExpenseAgorot });
      const { lines, nextState } = evaluatePhoneAlerts(delivery.state, facts);
      const message = composePhoneAlert(lines, { includeDetails: delivery.includeDetails, appUrl: deps.appUrl() });
      if (message) {
        const outcome = await deps.send(delivery.topic, message);
        if (!outcome.ok) {
          failed += 1;
          console.error(`phone alerts: send failed for one user: ${outcome.error}`);
          continue;
        }
        sent += 1;
      }
      await deps.saveState(userId, nextState);
    } catch (error) {
      failed += 1;
      console.error(`phone alerts: check failed for one user: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { ok: true, checked: userIds.length, sent, failed };
}

export type OperatorPhoneAlertOutcome = "sent" | "not_configured" | "failed";

type OperatorDeps = {
  operatorEmail: () => string | null;
  findUserIdByEmail: (email: string) => Promise<string | null>;
  getDelivery: typeof getPhoneAlertDelivery;
  send: typeof sendNtfy;
  appUrl: () => string;
};

async function findUserIdByEmail(email: string): Promise<string | null> {
  const admin = createAdminClient();
  const user = await admin.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } }, select: { id: true } });
  return user?.id ?? null;
}

const defaultOperatorDeps: OperatorDeps = {
  operatorEmail: getOperatorAlertEmail,
  findUserIdByEmail,
  getDelivery: getPhoneAlertDelivery,
  send: sendNtfy,
  appUrl: getAppUrl,
};

/**
 * The cron's failure alert, on the operator's phone as well as by email
 * (§3yy): the operator is the account whose sign-in address is
 * OPERATOR_ALERT_EMAIL, and this uses that account's own topic. Not
 * configured when either is missing. Never throws.
 */
export async function sendOperatorPhoneAlert(
  failures: readonly string[],
  deps: OperatorDeps = defaultOperatorDeps,
): Promise<OperatorPhoneAlertOutcome> {
  try {
    const email = deps.operatorEmail();
    if (!email) return "not_configured";
    const userId = await deps.findUserIdByEmail(email);
    const delivery = userId ? await deps.getDelivery(userId) : null;
    if (!delivery) return "not_configured";

    const count = `${failures.length} nightly job${failures.length === 1 ? "" : "s"} failed`;
    const message: NtfyMessage = {
      title: "PFW: cron failed",
      message: delivery.includeDetails ? [count, ...failures].join("\n") : `${count}. See the email or the Vercel logs.`,
      priority: 4,
      click: `${deps.appUrl()}/settings/ops`,
    };
    const outcome = await deps.send(delivery.topic, message);
    if (!outcome.ok) console.error(`operator phone alert: ${outcome.error}`);
    return outcome.ok ? "sent" : "failed";
  } catch (error) {
    console.error(`operator phone alert failed: ${error instanceof Error ? error.message : String(error)}`);
    return "failed";
  }
}
