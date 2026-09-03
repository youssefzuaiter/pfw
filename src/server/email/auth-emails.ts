import "server-only";
import { sendEmail } from "./resend-client";

/**
 * Auth hardening pass (ad hoc, post-§3ff) — the two outbound-email
 * templates this app sends: a password-reset link and an email-
 * verification link. Plain inline-styled HTML (no template engine/
 * dependency, matching this project's "own small surfaces directly"
 * habit) plus a real plain-text alternative, since not every email
 * client renders HTML.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function wrapEmailHtml(heading: string, bodyHtml: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#18181b;">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:8px;padding:32px;">
      <h1 style="margin:0 0 16px;font-size:18px;font-weight:600;">${escapeHtml(heading)}</h1>
      ${bodyHtml}
      <p style="margin:24px 0 0;font-size:12px;color:#71717a;">PFW — personal finance</p>
    </div>
  </body>
</html>`;
}

function linkButtonHtml(url: string, label: string): string {
  return `<a href="${escapeHtml(url)}" style="display:inline-block;margin:16px 0;padding:10px 20px;background:#385bcb;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:500;">${escapeHtml(label)}</a>`;
}

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  const bodyHtml = `
    <p style="margin:0 0 8px;font-size:14px;line-height:1.5;">
      We received a request to reset the password for this account. This link expires in 15 minutes and can only be used once.
    </p>
    ${linkButtonHtml(resetUrl, "Reset your password")}
    <p style="margin:16px 0 0;font-size:12px;color:#71717a;line-height:1.5;">
      If you didn't request this, you can safely ignore this email — your password will not be changed.
    </p>`;

  await sendEmail({
    to,
    subject: "Reset your PFW password",
    html: wrapEmailHtml("Reset your password", bodyHtml),
    text: `We received a request to reset the password for this account.\n\nThis link expires in 15 minutes and can only be used once:\n${resetUrl}\n\nIf you didn't request this, you can safely ignore this email.`,
  });
}

export async function sendVerificationEmail(to: string, verifyUrl: string): Promise<void> {
  const bodyHtml = `
    <p style="margin:0 0 8px;font-size:14px;line-height:1.5;">
      Confirm this is your email address to finish securing your PFW account. This link expires in 24 hours.
    </p>
    ${linkButtonHtml(verifyUrl, "Verify your email")}
    <p style="margin:16px 0 0;font-size:12px;color:#71717a;line-height:1.5;">
      If you didn't create a PFW account, you can safely ignore this email.
    </p>`;

  await sendEmail({
    to,
    subject: "Verify your PFW email address",
    html: wrapEmailHtml("Verify your email", bodyHtml),
    text: `Confirm this is your email address to finish securing your PFW account.\n\nThis link expires in 24 hours:\n${verifyUrl}\n\nIf you didn't create a PFW account, you can safely ignore this email.`,
  });
}
