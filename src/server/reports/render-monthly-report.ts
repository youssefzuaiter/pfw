import { agorot, formatAgorot } from "../../lib/money";
import { formatNativeAmount, nativeAmount } from "../../lib/currency";
import { monthKeyToStartDate } from "../../lib/date-month";
import type { MonthlyReportData } from "./monthly-report";

/**
 * The monthly report as an email (AGENTS.md §3lll): a subject, a plain-text
 * body and a minimal HTML body carrying the same lines. Pure, so it is tested
 * without a database or a mail service.
 *
 * Every value is escaped in the HTML, including category names, which are the
 * user's own text. No colour codes: mail clients ignore the app's design
 * tokens, and the plain layout reads the same everywhere.
 */
export type RenderedReport = { subject: string; text: string; html: string };

function monthLabel(monthKey: string): string {
  return monthKeyToStartDate(monthKey).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

function shekels(value: bigint, signed = false): string {
  return formatAgorot(agorot(Number(value)), { showPositiveSign: signed });
}

function dollars(cents: number, signed = false): string {
  return formatNativeAmount(nativeAmount(cents), "USD", { showPositiveSign: signed });
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Lines of [label, value]; a null label is a free-standing sentence. */
type Line = [label: string | null, value: string];

function sections(data: MonthlyReportData): { title: string; lines: Line[] }[] {
  const net = data.incomeAgorot - data.expenseAgorot;
  const result = [
    {
      title: "Money in and out",
      lines: [
        ["Income", shekels(data.incomeAgorot)],
        ["Spending", shekels(data.expenseAgorot)],
        ["Net", shekels(net, true)],
      ] as Line[],
    },
    {
      title: "Where the money went",
      lines:
        data.topCategories.length === 0
          ? ([[null, "No spending recorded this month."]] as Line[])
          : data.topCategories.map((category): Line => [category.name, shekels(category.spentAgorot)]),
    },
    {
      title: "Net worth",
      lines: data.netWorth
        ? ([
            ["Start of month", shekels(data.netWorth.startAgorot)],
            ["End of month", shekels(data.netWorth.endAgorot)],
            ["Change", shekels(data.netWorth.endAgorot - data.netWorth.startAgorot, true)],
          ] as Line[])
        : ([[null, "Not enough history yet: net worth is recorded nightly, so the next report will show the change."]] as Line[]),
    },
  ];

  if (data.core) {
    const { startUsdCents, endUsdCents } = data.core;
    const change = endUsdCents - startUsdCents;
    const percent = startUsdCents === 0 ? null : (change / startUsdCents) * 100;
    result.push({
      title: "Long-term core (paper account)",
      lines: [
        ["Start of month", dollars(startUsdCents)],
        ["End of month", dollars(endUsdCents)],
        ["Change", `${dollars(change, true)}${percent === null ? "" : ` (${percent >= 0 ? "+" : ""}${percent.toFixed(2)}%)`}`],
      ],
    });
  }
  return result;
}

export function renderMonthlyReport(data: MonthlyReportData, appUrl: string): RenderedReport {
  const label = monthLabel(data.monthKey);
  const subject = `Your PFW summary for ${label}`;
  const blocks = sections(data);
  const dashboardUrl = `${appUrl.replace(/\/$/, "")}/dashboard`;

  const text = [
    subject,
    "",
    ...blocks.flatMap((block) => [
      block.title,
      ...block.lines.map(([name, value]) => (name === null ? `  ${value}` : `  ${name}: ${value}`)),
      "",
    ]),
    `Open the dashboard: ${dashboardUrl}`,
    "You receive this because the monthly report is turned on in Settings.",
  ].join("\n");

  const htmlBlocks = blocks
    .map((block) => {
      const rows = block.lines
        .map(([name, value]) =>
          name === null
            ? `<tr><td colspan="2" style="padding:2px 0;color:dimgray">${escapeHtml(value)}</td></tr>`
            : `<tr><td style="padding:2px 16px 2px 0">${escapeHtml(name)}</td><td style="padding:2px 0;text-align:right;font-variant-numeric:tabular-nums">${escapeHtml(value)}</td></tr>`,
        )
        .join("");
      return `<h2 style="font-size:14px;margin:20px 0 6px">${escapeHtml(block.title)}</h2><table style="border-collapse:collapse;font-size:14px">${rows}</table>`;
    })
    .join("");

  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:520px">
<h1 style="font-size:18px;margin:0 0 4px">${escapeHtml(subject)}</h1>${htmlBlocks}
<p style="margin-top:24px;font-size:14px"><a href="${escapeHtml(dashboardUrl)}">Open the dashboard</a></p>
<p style="font-size:12px;color:dimgray">You receive this because the monthly report is turned on in Settings.</p>
</div>`;

  return { subject, text, html };
}
