import { neutralizeFormulaInjection } from "../csv-import/formula-injection";

/**
 * The data export's pure half (AGENTS.md §3uuu): which tables go in, how a
 * stored value becomes plain JSON or a CSV cell, and how other people's
 * identifiers are redacted from the user's own rows. No database access, so
 * all of it is tested with plain literals.
 */

/**
 * Every user-owned table that goes into an export, in the order it is
 * written. tests/guards/data-export-coverage.test.ts fails when a model with
 * a userId column is in neither this list nor EXCLUDED_FROM_EXPORT.
 */
export const EXPORT_TABLES = [
  "bankAccounts",
  "bankConnections",
  "categories",
  "transactions",
  "transactionSplits",
  "transactionRules",
  "envelopeAllocations",
  "goals",
  "goalContributions",
  "debts",
  "debtPayments",
  "manualAssets",
  "cryptoWallets",
  "portfolioHoldings",
  "holdingLots",
  "trades",
  "dividends",
  "scenarioMetrics",
  "coreJournalEntries",
  "coreSnapshots",
  "coreRouterStatus",
  "netWorthSnapshots",
  "subscriptionTracking",
  "merchantEmbeddings",
  "settings",
  "phoneAlertSubscription",
  "notifications",
  "passkeys",
  "deadMansSwitch",
  "beneficiaries",
  "emergencyDocuments",
  "householdsCreated",
  "householdMemberships",
  "householdInvitesSent",
  "auditLog",
  "ledgerCommits",
] as const;

export type ExportTableName = (typeof EXPORT_TABLES)[number];

/** Prisma model name of each exported table, for the coverage guard. */
export const EXPORT_TABLE_MODELS: Record<ExportTableName, string> = {
  bankAccounts: "BankAccount",
  bankConnections: "BankConnection",
  categories: "Category",
  transactions: "NotableTransaction",
  transactionSplits: "TransactionSplit",
  transactionRules: "TransactionRule",
  envelopeAllocations: "EnvelopeAllocation",
  goals: "Goal",
  goalContributions: "GoalContribution",
  debts: "Debt",
  debtPayments: "DebtPayment",
  manualAssets: "ManualAsset",
  cryptoWallets: "CryptoWallet",
  portfolioHoldings: "PortfolioHolding",
  holdingLots: "HoldingLot",
  trades: "Trade",
  dividends: "Dividend",
  scenarioMetrics: "ScenarioMetrics",
  coreJournalEntries: "CoreJournalEntry",
  coreSnapshots: "CoreSnapshot",
  coreRouterStatus: "CoreRouterStatus",
  netWorthSnapshots: "NetWorthSnapshot",
  subscriptionTracking: "SubscriptionTracking",
  merchantEmbeddings: "MerchantEmbedding",
  settings: "UserSettings",
  phoneAlertSubscription: "PhoneAlertSubscription",
  notifications: "Notification",
  passkeys: "Authenticator",
  deadMansSwitch: "DeadMansSwitch",
  beneficiaries: "Beneficiary",
  emergencyDocuments: "EmergencyDocument",
  householdsCreated: "SharedGroup",
  householdMemberships: "GroupMember",
  householdInvitesSent: "GroupInvite",
  auditLog: "AuditLog",
  ledgerCommits: "LedgerCommit",
};

/** User-owned models deliberately left out, and why. */
export const EXCLUDED_FROM_EXPORT: Record<string, string> = {
  PasswordResetToken: "Hashes of single-use sign-in secrets; no use outside the app.",
  EmailVerificationToken: "Hashes of single-use sign-in secrets; no use outside the app.",
  RecoveryCode: "Hashes of your two-factor backup codes; exporting them would only weaken them.",
  Challenge: "Passkey sign-in challenges that expire within minutes.",
  RecoveryShareSubmission: "Shares your Emergency Vault beneficiaries submitted: theirs, and secret.",
};

/** Columns never exported, per table: credentials and secrets, even the user's own. */
export const OMITTED_COLUMNS: Partial<Record<ExportTableName | "account", readonly string[]>> = {
  account: ["passwordHash", "totpSecret", "totpLastUsedTimeStep", "tokenVersion", "failedLoginAttempts", "accountLockedAt"],
  bankConnections: ["accessToken"],
  phoneAlertSubscription: ["topic"],
  passkeys: ["credentialId", "publicKey", "counter"],
  beneficiaries: ["shareHash", "inviteTokenHash"],
  householdInvitesSent: ["tokenHash", "acceptedById"],
  merchantEmbeddings: ["embedding"],
};

export const REDACTED_PERSON = "[redacted: another person]";
/** A household the user belongs to but someone else owns: its id is that person's. */
export const REDACTED_HOUSEHOLD = "[household owned by another person]";

export type ExportValue = string | number | boolean | null | ExportValue[] | { [key: string]: ExportValue };
export type ExportRow = Record<string, ExportValue>;

/**
 * A stored value as plain JSON. BigInt becomes a decimal string, always:
 * money is integer minor units and must stay exact, and a JSON number loses
 * digits past 2^53 (a wallet's gas fees in wei do). Decimal becomes its
 * string, a Date its ISO form, bytes base64.
 */
export function toExportValue(value: unknown): ExportValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (Array.isArray(value)) return value.map(toExportValue);
  if (typeof value === "object") {
    // Prisma.Decimal and anything else with its own exact string form.
    if (isDecimalLike(value)) return value.toString();
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, toExportValue(inner)]));
  }
  return String(value);
}

function isDecimalLike(value: object): value is { toString(): string } {
  return typeof (value as { toFixed?: unknown }).toFixed === "function" && typeof (value as { isNaN?: unknown }).isNaN === "function";
}

export function toExportRow(record: Record<string, unknown>): ExportRow {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, toExportValue(value)]));
}

/** Keys whose value names another person: their user id or their email. */
const PERSON_KEY = /(userid|email)$/i;

/**
 * The user's own rows can still name other people: the audit log records
 * the member a household owner removed, the new owner of a transferred
 * household, the address an invite went to. Those identifiers are the other
 * person's, so they are replaced — anywhere in a JSON value, at any depth —
 * unless they are the exporting user's own.
 */
export function redactOtherPeople(value: ExportValue, self: { id: string; email: string }): ExportValue {
  if (Array.isArray(value)) return value.map((item) => redactOtherPeople(item, self));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        PERSON_KEY.test(key) && typeof inner === "string" && !isSelf(inner, self) ? REDACTED_PERSON : redactOtherPeople(inner, self),
      ]),
    );
  }
  return value;
}

function isSelf(value: string, self: { id: string; email: string }): boolean {
  return value === self.id || value.toLowerCase() === self.email.toLowerCase();
}

/** A number as written by this export (bigint strings included): safe in a spreadsheet as-is. */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * One CSV cell. Text that a spreadsheet would run as a formula (= + - @ tab
 * CR first) gets a leading apostrophe, the same guard the importer uses —
 * except a plain number: "-125.50" is a value, not a formula, and must stay
 * one. Objects and arrays become their JSON.
 */
export function toCsvCell(value: ExportValue): string {
  if (value === null) return "";
  let text: string;
  if (typeof value === "string") text = PLAIN_NUMBER.test(value) ? value : neutralizeFormulaInjection(value);
  else if (typeof value === "number" || typeof value === "boolean") text = String(value);
  else text = neutralizeFormulaInjection(JSON.stringify(value));
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Rows to CSV text: one header row of every key any row has, in first-seen order. Empty input, empty string. */
export function toCsv(rows: readonly ExportRow[]): string {
  const columns: string[] = [];
  for (const row of rows) for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  if (columns.length === 0) return "";
  const lines = [columns.map((column) => toCsvCell(column)).join(",")];
  for (const row of rows) lines.push(columns.map((column) => toCsvCell(row[column] ?? null)).join(","));
  return lines.join("\r\n") + "\r\n";
}

export const EXPORT_NOTES = {
  amounts:
    "Money is stored as whole minor units, written as text so no digit is lost: agorot for ILS (12550 = 125.50), cents for USD/EUR/GBP, kuruş for TRY. `amount` and other *Agorot columns are shekels; `nativeAmount`, `nativeBalance` and other native* columns are in the row's own `currency`.",
  rates: "Exchange rates (exchangeRateAtEntry) are shekels per one unit of the foreign currency, frozen when the row was recorded.",
  aprBps: "Interest rates are basis points: 725 = 7.25%.",
  encryptedInBrowser:
    "Goal notes starting with zk1: and Emergency Vault documents starting with dms1: were encrypted in your browser with your passphrase. The server cannot read them, so they are exported as they are stored, with the salt and iteration count needed to decrypt them.",
  omitted:
    "Left out on purpose: your password hash, two-factor secret and backup codes, passkey keys, bank-connection and phone-alert secrets, and single-use sign-in tokens.",
  redacted: `Other people named in your own records (a household member's user id, an invited email address) appear as "${REDACTED_PERSON}", and a household someone else owns appears as "${REDACTED_HOUSEHOLD}".`,
  deleted: "Transactions you deleted are included, with their deletedAt date.",
} as const;
