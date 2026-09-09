// services/mail/smtp.transport.ts
//
// Plain SMTP via nodemailer — the transport that actually works for a
// self-hosted install. Any ordinary mailbox will do (a Gmail account with an
// app password, Brevo, Zoho, ...): no domain to verify, no public deployment,
// and it delivers to arbitrary recipients rather than just the account owner.

import nodemailer, { type Transporter } from "nodemailer";
import type { MailMessage, MailTransport, SendResult } from "./transport.js";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

export function readSmtpConfig(from: string): SmtpConfig | null {
  const host = process.env.SMTP_HOST?.trim();
  if (!host) return null;

  // Implicit TLS on 465, STARTTLS on everything else — the same default
  // nodemailer applies, spelled out so SMTP_SECURE only has to be set when
  // a server deviates from it.
  const port = Number(process.env.SMTP_PORT) || 587;
  const secure =
    process.env.SMTP_SECURE !== undefined
      ? process.env.SMTP_SECURE === "true"
      : port === 465;

  return {
    host,
    port,
    secure,
    user: process.env.SMTP_USER?.trim() || undefined,
    pass: process.env.SMTP_PASS || undefined,
    from,
  };
}

export class SmtpTransport implements MailTransport {
  readonly name = "smtp";

  private readonly transporter: Transporter;
  private readonly from: string;
  /** `verify()` runs once, on the first send, and never blocks a send. */
  private verified = false;

  constructor(config: SmtpConfig) {
    this.from = config.from;
    this.transporter = nodemailer.createTransport({
      host:   config.host,
      port:   config.port,
      secure: config.secure,
      auth:
        config.user && config.pass
          ? { user: config.user, pass: config.pass }
          : undefined,
      pool: true,
    });
  }

  async send(msg: MailMessage): Promise<SendResult> {
    await this.verifyOnce();

    const info = await this.transporter.sendMail({
      from:    this.from,
      to:      msg.to,
      subject: msg.subject,
      html:    msg.html,
      text:    msg.text,
    });

    return { id: info.messageId ?? "unknown" };
  }

  /** Diagnostic only. A failure here is logged, not thrown: the send that
   *  follows produces the real, specific error, and a transient handshake
   *  failure must not permanently poison the transport. */
  private async verifyOnce(): Promise<void> {
    if (this.verified) return;
    this.verified = true;

    try {
      await this.transporter.verify();
      console.log("[Mail] SMTP connection verified.");
    } catch (err: any) {
      console.error("[Mail] SMTP verification failed:", err?.message ?? err);
    }
  }
}
