// services/mail/transport.ts
//
// How a message is delivered, separated from what it says. `MailService` owns
// the templates and the account-flow semantics; a transport only knows how to
// put one rendered message on the wire.
//
// The split exists because Resend cannot serve a self-hosted install: on its
// sandbox sender (`onboarding@resend.dev`) it delivers only to the account
// owner's own address, and lifting that needs a *verified sender domain*.
// An install running behind an ephemeral trycloudflare tunnel has no domain
// to verify, so it needs a transport that works from an ordinary mailbox.

export interface SendResult {
  /** Provider-assigned message id, for logging. Not persisted anywhere. */
  id: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface MailTransport {
  /** Short name, logged at startup so an install's mail path is obvious. */
  readonly name: string;
  send(msg: MailMessage): Promise<SendResult>;
}
