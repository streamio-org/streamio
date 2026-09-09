// services/mail/link-base.ts
//
// Which base URL a verification/reset link should point at: `APP_URL`.
//
// If this install sits behind a reverse proxy with a hostname that can change
// (a Cloudflare Tunnel you run yourself, a dynamic-DNS setup, ...), `APP_URL`
// can go stale between when a mail is sent and when it's clicked — that is
// why every such email also carries the raw token for manual entry (see
// `MailService`), which no base-URL lookup can fully substitute for.

import { appBaseUrl } from "../../version.js";

/** The public base URL to build email links from. Never throws. */
export function resolvePublicBase(): string {
  return appBaseUrl();
}
