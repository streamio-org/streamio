// services/mail/log.transport.ts
//
// The fallback when nothing is configured. It sends nothing — it prints the
// message (including the verification/reset link and token) to stdout.
//
// This is what makes an unconfigured install usable rather than broken: the
// server boots, registration succeeds, and an admin can complete a
// verification or a password reset by copying the link out of
// `docker compose logs streamio`.

import type { MailMessage, MailTransport, SendResult } from "./transport.js";

export class LogTransport implements MailTransport {
  readonly name = "log";

  async send(msg: MailMessage): Promise<SendResult> {
    console.log(
      [
        "",
        "─── [Mail] not sent (no transport configured) ───────────────",
        `  To:      ${msg.to}`,
        `  Subject: ${msg.subject}`,
        "",
        msg.text.split("\n").map((line) => `  ${line}`).join("\n"),
        "─────────────────────────────────────────────────────────────",
        "",
      ].join("\n")
    );

    return { id: `log-${Date.now()}` };
  }
}
