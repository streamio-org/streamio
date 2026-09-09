// services/mail/resend.transport.ts
//
// The original transport, kept for installs that do have a verified sender
// domain. Opt in with RESEND_API_KEY (or MAIL_TRANSPORT=resend).
//
// Note the sandbox limitation this whole layer exists to work around: with
// MAIL_FROM unset the sender is `onboarding@resend.dev`, and Resend then
// delivers only to the Resend account owner's own address. Every other
// recipient is rejected, which reads as "verification email never arrived".

import { Resend } from "resend";
import type { MailMessage, MailTransport, SendResult } from "./transport.js";

export class ResendTransport implements MailTransport {
  readonly name = "resend";

  private readonly resend: Resend;
  private readonly from: string;

  constructor(apiKey: string, from: string) {
    this.resend = new Resend(apiKey);
    this.from   = from;
  }

  async send(msg: MailMessage): Promise<SendResult> {
    const { data, error } = await this.resend.emails.send({
      from:    this.from,
      to:      msg.to,
      subject: msg.subject,
      html:    msg.html,
      text:    msg.text,
    });

    if (error || !data) {
      throw new Error(error?.message ?? "Resend rejected the message");
    }

    return data;
  }
}
