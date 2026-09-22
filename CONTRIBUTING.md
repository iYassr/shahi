# Contributing to Shahi

Thanks for looking. Shahi is a phone-shaped view of a running
[herdr](https://herdr.dev) session — a thin native app over a small server
sidecar. This is the short version; `CLAUDE.md` is the long, candid one that
governs how the code is meant to grow, and it outranks anything here that
disagrees.

## Layout

```
shared/   the wire contract and the end-to-end crypto — both clients import it
server/   Bun sidecar: owns herdr's unix socket, speaks HTTP + WebSocket
mobile/   the Expo app — the product, and where new work goes
plugin/   the herdr plugin: startup hook, actions, the service it installs
relay/    the blind relay: a Cloudflare Worker, one Durable Object per box
web/      the actively maintained responsive React PWA
e2e/      Playwright, against a stub of the server
```

The native app and web app are actively maintained together. Keep shared user
flows aligned; native-only capabilities such as the built-in SSH tunnel remain
native. See [CLAUDE.md](CLAUDE.md) for the supported API contract.

## Running it

```sh
bun install
bun run test                              # unit and dependency checks
bun run typecheck                          # every workspace, incl. the app
```

The app needs a Mac to build for iOS. See `docs/on-a-mac.md` and, for the SSH
module, `docs/ssh.md`.

## How to build here

A few principles from `CLAUDE.md`, because PRs are reviewed against them:

- **Preserve supported contracts.** Support the current and previous API
  generation for the release-policy window, without restoring protocols below
  API 5 / encrypted transport 2. See [releases](docs/releases.md).
- **Simplest thing that fully meets the requirement.** No speculative
  abstraction or configuration.
- **Grow in layers** — the smallest version that works end to end, then build on
  a product that already works.
- **Comments explain _why_, especially why not the obvious alternative.** A
  comment that restates the code is worse than none.
- Commit messages are prose — what broke, how it was found, what it cost — not
  bullet lists of changed files.

## Tests

- Unit and dependency checks: `bun run test`.
- Native component tests: `bun run test:mobile`.
- Relay: `bun run test:relay` (set `SHAHI_TEST_RELAY_PORT` if 8787 is in use).
- Browser: `bun run build:web && bun run test:e2e`.
- Hosted client and offline/update behavior: `bun run build:site && bun run test:hosted && bun run test:pwa`.
- Native flows: Maestro in `.maestro/` and the creation matrix in `e2e/native/`;
  see [local iOS development](docs/on-a-mac.md).

Fixture tests must never send writes to a real user session. Real-server tests
require both a named herdr session and a fresh `XDG_CONFIG_HOME` without installed
plugins: startup hooks can otherwise redirect the production service. Use
dedicated test workspaces and upload directories, revoke temporary devices, and
stop only the test services afterward. Never log terminal contents. Record real
server checks separately from fixture results and physical-device checks.

New behaviour should come with a test named after the symptom it prevents.

## Before opening a PR

- `bun run typecheck` and the unit tests pass.
- No secrets, tokens, or personal data in the diff.

By contributing you agree your contributions are licensed under the repo's
`LICENSE`.
