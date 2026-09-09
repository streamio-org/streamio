# Contributing to Streamio

Thanks for taking the time to contribute. This project is a self-hosted media platform, and
changes here run on real users' home servers — so a bit of process goes a long way.

## Before you start

- For anything larger than a small fix (a new feature, a schema change, a new provider), open an
  issue first so we can talk through the approach before you invest the time.
- For a small fix (typo, bug with an obvious one-line cause, docs), a pull request without a
  preceding issue is fine.
- Check [`docs/architecture.md`](docs/architecture.md) before touching `core/`, the provider
  registry, or auth — several invariants there are load-bearing and not obvious from the code
  alone.

## Development setup

See [Getting Started](docs/getting-started.md) and [Development](docs/development.md) for the
full local dev loop. The short version:

```bash
npm install
npm run build        # compile TS to dist/
npm run dev           # build/watch + run via nodemon
npx tsc --noEmit       # type-check only, fastest correctness check
```

Server start applies pending DB migrations automatically — there's no separate migrate step, and
no supported way to run against a stale schema.

## Tests

```bash
npm run test:providers      # requires DATABASE_URL with at least one ready local title
npm run test:genres         # same DB requirement
npm run test:device-login   # TV pairing code helpers
npm run test:ssrf           # outbound-URL guard (private/reserved address classification, DNS rebinding)
```

Run whichever suite covers the area you touched. `test:ssrf` in particular should never be
skipped if you touch anything that fetches a caller-supplied URL.

## Making changes

- Keep pull requests focused — one logical change per PR is easier to review and easier to
  revert if something goes wrong.
- Match the existing code style; there's no separate linter/formatter step beyond
  `npx tsc --noEmit`.
- Update relevant docs in `docs/` when behavior changes — several files there (especially
  `architecture.md`) describe *why* something is built a certain way, not just what it does, and
  are meant to stay current.
- Don't add speculative abstractions or config flags for hypothetical future use cases; prefer the
  direct implementation for the case at hand.

## Security issues

Please **do not** open a public issue for a security vulnerability. See
[`SECURITY.md`](SECURITY.md) for how to report one privately.

## Submitting a pull request

1. Fork the repo and create your branch from `main`.
2. Make your changes, with tests/docs updated as needed.
3. Make sure `npx tsc --noEmit` passes and the relevant test suites pass.
4. Open the PR using the provided template, describing what changed and why.

A maintainer will review as soon as possible. We may ask for changes before merging — that's
normal, not a rejection.

## License

By contributing, you agree that your contributions will be licensed under the project's
[CC BY-NC-SA 4.0](LICENSE) license.
