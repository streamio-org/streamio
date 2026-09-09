// services/mail.service.ts
//
// Transactional email: verification, password reset, welcome.
//
// Delivery is pluggable (see `services/mail/`) because Resend alone cannot
// serve a self-hosted install — without a verified sender domain it only
// delivers to the Resend account owner, and a self-hosted install typically
// has no domain to verify. SMTP from an ordinary mailbox does work, so that
// is the default whenever it is configured.
//
// Nothing in here throws at construction: a mail misconfiguration must not
// stop the server booting, and an unconfigured install falls back to logging
// the message so links can still be recovered from the server output.

import type { MailTransport, SendResult } from "./mail/transport.js";
import { SmtpTransport, readSmtpConfig } from "./mail/smtp.transport.js";
import { ResendTransport } from "./mail/resend.transport.js";
import { LogTransport } from "./mail/log.transport.js";
import { resolvePublicBase } from "./mail/link-base.js";

export type { SendResult } from "./mail/transport.js";

// ── Transport selection ──────────────────────────────────────

/**
 * The chosen transport, built once per process.
 *
 * `AccountService` — and with it `MailService` — is constructed by several
 * routers, so this must not be per-instance: `SmtpTransport` holds a pooled
 * nodemailer connection, and one pool (plus one startup log line) is the
 * point. Config is read from the environment, which doesn't change at
 * runtime, so a shared instance is always the right one.
 */
let shared: MailTransport | null = null;

function getTransport(from: string): MailTransport {
  if (!shared) {
    shared = selectTransport(from);
    console.log(`[Mail] Using "${shared.name}" transport, from ${from}.`);
  }
  return shared;
}

/** `MAIL_TRANSPORT` forces one; unset auto-detects from what's configured. */
function selectTransport(from: string): MailTransport {
  const forced    = process.env.MAIL_TRANSPORT?.trim().toLowerCase();
  const smtp      = readSmtpConfig(from);
  const resendKey = process.env.RESEND_API_KEY?.trim();

  if (forced === "smtp" || (!forced && smtp)) {
    if (smtp) return new SmtpTransport(smtp);
    console.error("[Mail] MAIL_TRANSPORT=smtp but SMTP_HOST is unset — falling back to logging.");
    return new LogTransport();
  }

  if (forced === "resend" || (!forced && resendKey)) {
    if (resendKey) return new ResendTransport(resendKey, from);
    console.error("[Mail] MAIL_TRANSPORT=resend but RESEND_API_KEY is unset — falling back to logging.");
    return new LogTransport();
  }

  if (!forced) {
    console.warn(
      "[Mail] No mail transport configured (set SMTP_HOST, or RESEND_API_KEY). " +
      "Emails will be printed to the server log instead of sent."
    );
  }

  return new LogTransport();
}

// ── MailService ──────────────────────────────────────────────

export class MailService {
  private readonly transport: MailTransport;
  private readonly from: string;
  private readonly appName: string;

  constructor() {
    this.from      = process.env.MAIL_FROM ?? "onboarding@resend.dev"; // Resend's sandbox sender
    this.appName   = process.env.APP_NAME  ?? "MyApp";
    this.transport = getTransport(this.from);
  }

  /** Where email links point — resolved per send, in case `APP_URL` changes. */
  private baseUrl(): string {
    return resolvePublicBase();
  }

  // ── Verification ──────────────────────────────────────────

  async sendVerificationEmail(
    to: string,
    token: string
  ): Promise<SendResult> {
    const link = `${await this.baseUrl()}/verify-email?token=${token}`;

    return this.transport.send({
      to,
      subject: `Verify your ${this.appName} email`,
      html:    this.verificationHtml(link, token),
      text:
        `Verify your email: ${link}\n\n` +
        `If that link doesn't open, go to ${this.appName} → /verify-email and paste this code:\n` +
        `${token}\n\n` +
        `This link expires in 24 hours.`,
    });
  }

  // ── Password reset ────────────────────────────────────────

  async sendPasswordResetEmail(
    to: string,
    token: string
  ): Promise<SendResult> {
    const link = `${await this.baseUrl()}/reset-password?token=${token}`;

    return this.transport.send({
      to,
      subject: `Reset your ${this.appName} password`,
      html:    this.passwordResetHtml(link, token),
      text:
        `Reset your password: ${link}\n\n` +
        `If that link doesn't open, go to ${this.appName} → /reset-password and paste this code:\n` +
        `${token}\n\n` +
        `This link expires in 1 hour. If you didn't request this, ignore this email.`,
    });
  }

  // ── OAuth account claim ───────────────────────────────────

  /**
   * Sent when signing in with Google/Discord takes over a local account that
   * had a password but had never verified its address, and drops that
   * password (see `AccountService.upsertOAuthUser`).
   *
   * The recipient demonstrably owns this inbox — the provider just said so —
   * so this is the one channel that reaches the right person. It exists
   * because the alternative is a credential vanishing with no explanation:
   * either they set that password themselves and need to know why it stopped
   * working, or they didn't, in which case somebody else was sitting on their
   * address and they should know that too.
   */
  async sendOAuthClaimEmail(
    to: string,
    provider: "google" | "discord",
    displayName: string | null
  ): Promise<SendResult> {
    const name  = displayName ?? "there";
    const label = provider === "google" ? "Google" : "Discord";
    const base  = await this.baseUrl();

    return this.transport.send({
      to,
      subject: `Your ${this.appName} account is now signed in with ${label}`,
      html:    this.oauthClaimHtml(name, label, base),
      text:
        `Hey ${name},\n\n` +
        `You just signed in to ${this.appName} with ${label}, and this address had ` +
        `not been verified yet — so we've verified it and switched the account over ` +
        `to ${label} sign-in.\n\n` +
        `Any password previously set on this account no longer works, and every ` +
        `other session has been signed out. If you want a password again, use ` +
        `"Forgot password" at ${base}/login — the link goes to this inbox.\n\n` +
        `If you didn't just sign in with ${label}, someone else had registered this ` +
        `address before you. The account is yours now, but set a password and review ` +
        `it at ${base}/account.`,
    });
  }

  // ── Welcome ───────────────────────────────────────────────

  async sendWelcomeEmail(
    to: string,
    displayName: string | null
  ): Promise<SendResult> {
    const name = displayName ?? "there";
    const base = await this.baseUrl();

    return this.transport.send({
      to,
      subject: `Welcome to ${this.appName}!`,
      html:    this.welcomeHtml(name, base),
      text:    `Hey ${name}, welcome to ${this.appName}! Head over to ${base} to get started.`,
    });
  }

  // ── HTML templates ────────────────────────────────────────

  /**
   * Dark shell matching the app's own look (see `public/styles/auth-pages.css`).
   *
   * Everything is a nested table with fully inlined styles on purpose: email
   * clients strip <style> blocks, ignore flex/grid, and can't load web fonts,
   * so Bebas Neue — the brand face on the site — falls back to a condensed
   * system stack here rather than being linked.
   */
  private base(title: string, body: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="dark" />
  <meta name="supported-color-schemes" content="dark" />
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#0b0b0b;font-family:'DM Sans',ui-sans-serif,system-ui,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
    style="background:#0b0b0b;padding:40px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0"
          style="background:#1f1f1f;border:1px solid rgba(255,255,255,.08);border-radius:14px;overflow:hidden;">
          <tr>
            <td style="background:#141414;padding:22px 32px;border-bottom:1px solid rgba(255,255,255,.08);">
              <span style="color:#e50914;font-family:'Arial Narrow',Arial,sans-serif;font-size:26px;
                           font-weight:700;letter-spacing:.06em;text-transform:uppercase;">${this.appName}</span>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              ${body}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px 24px;border-top:1px solid rgba(255,255,255,.08);">
              <p style="margin:0;font-size:12px;color:#6b6b6b;line-height:1.6;">
                You received this email because you have an account at ${this.appName}.
                If you didn't expect this, you can safely ignore it.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  /** Table-wrapped rather than a bare inline-block <a>: Outlook drops the
   *  background on the latter and renders a bare link. */
  private btn(href: string, label: string): string {
    return `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 0;">
        <tr>
          <td align="center" bgcolor="#e50914" style="background:#e50914;border-radius:7px;">
            <a href="${href}"
              style="display:inline-block;padding:14px 30px;color:#ffffff;font-size:15px;
                     font-weight:700;text-decoration:none;"
            >${label}</a>
          </td>
        </tr>
      </table>`;
  }

  /** The link's host can go stale (the tunnel hostname changes on restart),
   *  so every token-bearing email also shows the token for manual entry. */
  private codeBlock(page: string, token: string): string {
    return `
      <p style="margin:26px 0 8px;font-size:13px;color:#b3b3b3;line-height:1.6;">
        If the link above doesn't open, go to <strong style="color:#ffffff;">${page}</strong>
        on ${this.appName} and paste this code:
      </p>
      <p style="margin:0;padding:12px 14px;background:#2a2a2a;border:1px solid rgba(255,255,255,.08);
                border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;
                color:#ffffff;word-break:break-all;">${token}</p>`;
  }

  private verificationHtml(link: string, token: string): string {
    return this.base("Verify your email", `
      <h1 style="margin:0 0 10px;font-size:24px;font-weight:700;color:#ffffff;">Verify your email</h1>
      <p style="margin:0;font-size:15px;color:#b3b3b3;line-height:1.6;">
        Click the button below to verify your email address. The link expires in
        <strong style="color:#ffffff;">24 hours</strong>.
      </p>
      ${this.btn(link, "Verify email")}
      ${this.codeBlock("/verify-email", token)}
    `);
  }

  private passwordResetHtml(link: string, token: string): string {
    return this.base("Reset your password", `
      <h1 style="margin:0 0 10px;font-size:24px;font-weight:700;color:#ffffff;">Reset your password</h1>
      <p style="margin:0;font-size:15px;color:#b3b3b3;line-height:1.6;">
        Someone requested a password reset for your account. Click below to set a new password.
        The link expires in <strong style="color:#ffffff;">1 hour</strong>.
      </p>
      ${this.btn(link, "Reset password")}
      ${this.codeBlock("/reset-password", token)}
      <p style="margin:22px 0 0;font-size:13px;color:#6b6b6b;line-height:1.6;">
        If you didn't request this, you can safely ignore this email — your password won't change.
      </p>
    `);
  }

  private oauthClaimHtml(name: string, label: string, base: string): string {
    return this.base(`Signed in with ${label}`, `
      <h1 style="margin:0 0 10px;font-size:24px;font-weight:700;color:#ffffff;">Hey ${name} 👋</h1>
      <p style="margin:0;font-size:15px;color:#b3b3b3;line-height:1.6;">
        You just signed in to <strong style="color:#ffffff;">${this.appName}</strong> with
        <strong style="color:#ffffff;">${label}</strong>. This address hadn't been verified yet,
        so we've verified it and switched the account over to ${label} sign-in.
      </p>
      <p style="margin:16px 0 0;font-size:15px;color:#b3b3b3;line-height:1.6;">
        Any password previously set on this account <strong style="color:#ffffff;">no longer
        works</strong>, and every other session has been signed out. You can set a new one at
        any time with &ldquo;Forgot password&rdquo; — that link comes back to this inbox.
      </p>
      ${this.btn(`${base}/login`, "Go to sign-in")}
      <p style="margin:22px 0 0;font-size:13px;color:#6b6b6b;line-height:1.6;">
        If that wasn't you, someone else had registered this address before you did. The account
        is yours now — set a password and take a look at your account page.
      </p>
    `);
  }

  private welcomeHtml(name: string, base: string): string {
    return this.base(`Welcome to ${this.appName}`, `
      <h1 style="margin:0 0 10px;font-size:24px;font-weight:700;color:#ffffff;">Hey ${name} 👋</h1>
      <p style="margin:0;font-size:15px;color:#b3b3b3;line-height:1.6;">
        Welcome to <strong style="color:#ffffff;">${this.appName}</strong>! Your account is all set.
        Head over and start exploring.
      </p>
      ${this.btn(base, `Open ${this.appName}`)}
    `);
  }
}
