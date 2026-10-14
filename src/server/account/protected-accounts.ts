import "server-only";
import { DEMO_LOGIN_EMAIL } from "../../lib/demo-credentials";
import { resolvePaperTradingUser } from "../paper-trader/resolve-paper-trading-user";

/**
 * Accounts this deployment depends on, which deleting would break for
 * everyone else (AGENTS.md §3ttt). Returns the reason a deletion is refused,
 * or null when it may go ahead.
 *
 * - The paper-trading account: the trader's signed receipts are booked
 *   against it (PAPER_TRADING_USER_EMAIL). Deleted, every receipt would
 *   fail and pile up in the trader's outbox.
 * - The demo account while demo mode is on: the login page's Demo Login
 *   button signs into it, and would stop working until the next re-seed.
 */
export async function whyAccountCannotBeDeleted(user: { id: string; email: string }): Promise<string | null> {
  if (process.env.NEXT_PUBLIC_DEMO_MODE === "true" && user.email.toLowerCase() === DEMO_LOGIN_EMAIL) {
    return "The demo account cannot be deleted while demo mode is on.";
  }
  const paperTrading = await resolvePaperTradingUser();
  if (paperTrading.status === "ok" && paperTrading.userId === user.id) {
    return "This account receives the paper trader's trades. Point PAPER_TRADING_USER_EMAIL at another account first.";
  }
  return null;
}
