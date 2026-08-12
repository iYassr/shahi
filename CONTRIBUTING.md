# Contributing to Shahi

Thanks for looking. Shahi is a phone-shaped view of a running
[herdr](https://herdr.dev) session — a thin native app over a small server
sidecar. This is the short version; `CLAUDE.md` is the long, candid one that
governs how the code is meant to grow, and it outranks anything here that
disagrees.

## Layout

```
shared/   the wire contract, types only — both clients import it
server/   Bun sidecar: owns herdr's unix socket, speaks HTTP + WebSocket
mobile/   the Expo app — the product, and where new work goes
web/       the React PWA, archived: kept working, no longer developed
e2e/       Playwright, against a stub of the server
```

The **native app (`mobile/`) is the product**; `web/` is archived and should not
gain features.

## Running it

```sh
bun install
bun test shared/src server web/src        # unit tests
bun run typecheck                          # all four packages, incl. the app
```

The app needs a Mac to build for iOS. See `docs/on-a-mac.md` and, for the SSH
module, `docs/ssh.md`.

## How to build here

A few principles from `CLAUDE.md`, because PRs are reviewed against them:

- **No backward-compatibility layers.** Remove obsolete paths; don't add
  fallbacks or migrations.
- **Simplest thing that fully meets the requirement.** No speculative
  abstraction or configuration.
- **Grow in layers** — the smallest version that works end to end, then build on
  a product that already works.
- **Comments explain _why_, especially why not the obvious alternative.** A
  comment that restates the code is worse than none.
- Commit messages are prose — what broke, how it was found, what it cost — not
  bullet lists of changed files.

## Tests

- Unit: `bun test …`
- Browser (archived web client): `bun run test:e2e`
- Native flows: Maestro in `.maestro/` (needs a booted simulator).

New behaviour should come with a test named after the symptom it prevents.

## Before opening a PR

- `bun run typecheck` and the unit tests pass.
- No secrets, tokens, or personal data in the diff.

By contributing you agree your contributions are licensed under the repo's
`LICENSE`.
