/**
 * Every mutating route under src/app/api (POST, PUT, PATCH, DELETE), and what
 * the route sweep does with each one. Key format: "METHOD /api/path".
 *
 * tests/guards/mutating-route-inventory.test.ts fails when a handler is in
 * neither list, or in both, so a new mutating route cannot ship without a
 * decision. An excluded route must say why; the reason is checked to be
 * non-empty.
 *
 * SWEPT_ROUTES are called by tests/integration/mutating-route-sweep.test.ts
 * with a throwaway user. The sweep asserts only that no route answers 500,
 * that a request without a valid Origin is refused, and that a body the route
 * cannot accept is refused with 400. It does not check business results.
 */

export const SWEPT_ROUTES = [
  "DELETE /api/assets/[id]",
  "DELETE /api/banking/connections/[id]",
  "DELETE /api/categories/[id]",
  "DELETE /api/crypto-wallets/[id]",
  "DELETE /api/debts/[id]",
  "DELETE /api/goals/[id]",
  "DELETE /api/groups/[id]",
  "DELETE /api/groups/[id]/invites/[inviteId]",
  "DELETE /api/groups/[id]/members/[memberUserId]",
  "DELETE /api/phone-alerts",
  "DELETE /api/transaction-rules/[id]",
  "PATCH /api/categories/[id]",
  "PATCH /api/envelopes/allocate",
  "PATCH /api/goals/contributions/[id]",
  "PATCH /api/groups/[id]",
  "PATCH /api/groups/[id]/members/[memberUserId]",
  "PATCH /api/notifications/[id]",
  "PATCH /api/phone-alerts",
  "PATCH /api/subscriptions/status",
  "PATCH /api/transaction-rules/[id]",
  "PATCH /api/transactions/[id]",
  "PATCH /api/user-settings",
  "POST /api/account/export",
  "POST /api/assets",
  "POST /api/assets/[id]/valuation",
  "POST /api/auth/revoke-sessions",
  "POST /api/banking/connections",
  "POST /api/banking/connections/[id]/sync",
  "POST /api/bank-accounts",
  "POST /api/categories",
  "POST /api/copilot/chat",
  "POST /api/crypto-wallets",
  "POST /api/dead-mans-switch/cancel-recovery",
  "POST /api/debts",
  "POST /api/debts/[id]/payments",
  "POST /api/envelopes/allocate",
  "POST /api/goals",
  "POST /api/goals/[id]/contributions",
  "POST /api/groups",
  "POST /api/groups/[id]/invites",
  "POST /api/groups/[id]/transfer-ownership",
  "POST /api/groups/share",
  "POST /api/mfa/confirm",
  "POST /api/mfa/disable",
  "POST /api/mfa/setup",
  "POST /api/phone-alerts",
  "POST /api/trades",
  "POST /api/transaction-rules",
  "POST /api/transactions",
  "POST /api/transactions/[id]/delete",
  "POST /api/transactions/[id]/transfer",
  "POST /api/transactions/category-suggestions/apply",
  "POST /api/transactions/import",
  "POST /api/transactions/import-batch/[batchId]",
  "POST /api/transactions/import-batch/[batchId]/restore",
  "POST /api/transactions/rules/apply",
  "POST /api/transactions/search",
] as const;

export const EXCLUDED_ROUTES: Record<string, string> = {
  "POST /api/account/delete": "Permanently deletes the signed-in account, which the sweep shares with every other route. Covered by tests/integration/account-deletion.test.ts and its own route test.",
  "POST /api/advisor": "Calls the Anthropic API: costs money and needs the network. Its tool-use loop is covered by tests/integration/copilot-tools.test.ts and the advisor's own unit tests.",
  "POST /api/chat": "Calls the Anthropic API (via @ai-sdk/anthropic): costs money and needs the network.",
  "POST /api/transactions/category-suggestions": "Calls the Anthropic API: costs money and needs the network. Covered by its own route test and src/server/categorization/claude-category-suggester.test.ts.",
  "POST /api/auth/forgot-password": "Sends a real email through Resend.",
  "POST /api/auth/resend-verification": "Sends a real email through Resend.",
  "POST /api/auth/register": "Creates accounts and can claim the demo account; closed unless REGISTRATION_OPEN=true. Covered by tests/integration/auth-credentials.test.ts, its own route test and tests/e2e/registration-closed.spec.ts.",
  "POST /api/auth/reset-password": "Needs a single-use token from an emailed link. Covered by tests/integration/password-reset-email-verification.test.ts.",
  "POST /api/auth/verify-email": "Needs a single-use token from an emailed link. Covered by tests/integration/password-reset-email-verification.test.ts.",
  "POST /api/auth/webauthn/authenticate-options": "Issues a sign-in challenge without a session. Covered by tests/integration/webauthn-passkeys.test.ts.",
  "POST /api/auth/webauthn/register-options": "Needs a real platform authenticator to finish. Covered by tests/integration/webauthn-passkeys.test.ts.",
  "POST /api/auth/webauthn/register-verify": "Needs a real platform authenticator's signed response. Covered by tests/integration/webauthn-passkeys.test.ts.",
  "DELETE /api/auth/webauthn/authenticators/[id]": "Needs a stored authenticator to remove. Covered by tests/integration/webauthn-passkeys.test.ts.",
  "POST /api/phone-alerts/test": "Sends a real push notification through ntfy.sh, a public service that rate-limits by address. Covered by src/app/api/phone-alerts/route.test.ts.",
  "POST /api/agent/halt": "Sends a halt to the paper trader. A test must never stop the real trader.",
  "POST /api/webhooks/core": "Signed by the paper trader's HMAC. Covered by src/app/api/webhooks/core/route.test.ts.",
  "POST /api/webhooks/metrics": "Signed by the paper trader's HMAC. Covered by tests/integration/paper-trader-webhooks.test.ts.",
  "POST /api/webhooks/trades": "Signed by the paper trader's HMAC. Covered by tests/integration/paper-trader-webhooks.test.ts.",
  "POST /api/dead-mans-switch/setup": "Needs client-side encrypted payloads and key shares. Covered by tests/integration/dead-mans-switch.test.ts.",
  "POST /api/dead-mans-switch/beneficiaries": "Needs client-side key shares. Covered by tests/integration/dead-mans-switch.test.ts.",
  "POST /api/dead-mans-switch/documents": "Needs client-side encrypted document content. Covered by tests/integration/dead-mans-switch.test.ts.",
  "DELETE /api/dead-mans-switch/documents/[id]": "Needs an existing vault document. Covered by tests/integration/dead-mans-switch.test.ts.",
  "POST /api/dead-mans-switch/rotate-passphrase": "Needs client-side re-encrypted payloads. Covered by tests/integration/dead-mans-switch.test.ts.",
  "POST /api/dead-mans-switch/recover/[token]": "Beneficiary route, authenticated by an invite token. Covered by tests/integration/dead-mans-switch.test.ts.",
  "POST /api/groups/invites/accept": "Needs a real invite token. Covered by tests/integration/shared-groups.test.ts.",
  "POST /api/zk/setup": "Needs client-side encrypted payloads. Covered by tests/integration/zk-vault.test.ts.",
  "POST /api/zk/rotate-passphrase": "Needs client-side re-encrypted payloads. Covered by tests/integration/zk-vault.test.ts.",
  "POST /api/zk/migrate-legacy": "Returns decrypted plaintext of legacy notes, so it is never called with a generic payload. Covered by tests/integration/zk-vault.test.ts.",
};

/**
 * Swept routes that intentionally skip the Origin guard because they change
 * nothing: a POST only because the query is too long for a URL. The sweep
 * does not expect a 403 from these. Each must also appear in SWEPT_ROUTES.
 */
export const ORIGIN_CHECK_EXEMPT: Record<string, string> = {
  "POST /api/transactions/search":
    "Read-only search. POST only because a 384-number query embedding does not fit in a URL, so it skips the origin guard (AGENTS.md §3cc).",
};
