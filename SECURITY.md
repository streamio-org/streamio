# Security Policy

## Supported Versions

Streamio ships as a single rolling release — there are no parallel maintained branches. Security
fixes are made against `main` and released as the next version. Only the latest published release
is supported; please update before reporting an issue that may already be fixed.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately using [GitHub Security Advisories](../../security/advisories/new) for this
repository. This lets us discuss and fix the issue before it's publicly disclosed.

Please include, as applicable:

- A description of the vulnerability and its impact
- Steps to reproduce (a minimal repro is very helpful)
- Affected version/commit
- Any suggested mitigation

We'll acknowledge your report as soon as possible and keep you updated as we work on a fix.
Once a fix is released, we'll credit you in the advisory (unless you'd prefer to stay anonymous).

## Scope

Areas that are especially security-sensitive in this codebase and worth extra care when
reporting or contributing near them:

- **Outbound request forgery** — anything that fetches a URL supplied by a client
  (`/api/cast-proxy`, resolved-video `server` payloads) must go through the SSRF guard in
  `core/utils/ssrf.ts`. See `npm run test:ssrf`.
- **Auth** — JWT issuance/verification (`auth/jwt.ts`), OAuth account linking (`auth/oauth.ts`),
  admin checks (`auth/middleware.ts`), and the TV device-login pairing flow
  (`auth/deviceLogin.ts`).
- **User-authored content rendered to other users** — display names, avatar URLs, share
  messages — must be escaped at every `innerHTML` sink (see `escapeHtml` usage in
  `public/scripts/auth.js`).
- **18+ content gating** — enforcement in `provider.router.ts`/`content.router.ts` and
  `adult-filter.service.ts` must stay server-side.

This is not an exhaustive list — if something looks off elsewhere, please still report it.

## Out of Scope

- Vulnerabilities requiring physical access to a self-hosted instance's host machine
- Issues in third-party dependencies without a demonstrated exploit path through this codebase
  (report those upstream instead)
- Social engineering
