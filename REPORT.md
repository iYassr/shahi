# Stream report: herdr plugin (`stream/herdr-plugin`)

`herdr plugin install iYassr/shahi` now gives someone who runs herdr a
supervised Shahi sidecar with generated secrets, a status/restart/stop/logs
set of actions, and a "Pair a phone" popup that prints the QR inside herdr.
`install.sh` is untouched. Two commits; nothing pushed.

## What changed

New:

- `herdr-plugin.toml` — the manifest: two build steps, one startup hook, six
  actions (`pair`, `status`, `restart`, `stop`, `logs`, `uninstall`), one
  popup pane (`pair`). Every command is `sh plugin/bun.sh …`.
- `plugin/bun.sh` — finds bun on PATH, `~/.bun/bin`, `/opt/homebrew/bin`,
  `/usr/local/bin`; prints the install line and exits 1 when there is none.
- `plugin/shahi.ts` — every verb: `setup` (= `restart`), `status`, `stop`,
  `logs`, `pair` (the popup's command, holds itself open, asks for the address
  when there is nothing to guess from), `open-pair` (the action; opens the
  popup via `HERDR_BIN_PATH`), `uninstall`.
- `plugin/service.ts` — renders and drives the LaunchAgent
  (`~/Library/LaunchAgents/app.shahi.sidecar.plist`) and the systemd user unit
  (`~/.config/systemd/user/shahi.service`).
- `plugin/layout.ts` — the paths, from `HERDR_PLUGIN_ROOT/CONFIG_DIR/STATE_DIR`
  and `HERDR_SOCKET_PATH` exactly as injected.
- `plugin/tsconfig.json`, `plugin/{manifest,service,layout}.test.ts`.
- `server/lib/secrets.ts` (+ test) — `.env` path, parse, secret generation,
  write. Moved out of `init-secrets.ts` so the plugin calls it rather than
  copies it, as the brief asked.
- `server/lib/endpoint.ts` (+ test) — the phone-address guess, moved out of
  `pair.ts` so the `status` action can use it and it can be unit-tested.
- `docs/plugin.md`.

Edited:

- `server/lib/config.ts` — `loadConfig` merges the file named by
  `SHAHI_ENV_FILE` under the process environment.
- `server/scripts/init-secrets.ts` — a thin CLI over `secrets.ts`; honours
  `SHAHI_ENV_FILE`.
- `server/scripts/pair.ts` — honours `SHAHI_ENV_FILE`; uses `secrets.ts` and
  `endpoint.ts` instead of its own copies. Behaviour unchanged.
- `package.json` — `typecheck` includes `-p plugin`; `test` includes `plugin`.
- `README.md` — install section leads with the plugin; install.sh under a
  details block; app step mentions scanning; docs list.
- `CLAUDE.md` — `plugin/` in the tree, the manifest line under it, one
  decision ("the startup hook installs a service; it is not the service"),
  and `plugin` in the unit-test command.

## Outside my ownership, and why

- `server/lib/secrets.ts`, `secrets.test.ts`, `endpoint.ts`, `endpoint.test.ts`
  are new files in `server/lib`. The brief allowed edits to `init-secrets.ts`,
  `pair.ts` and `config.ts` "only to let the env file be chosen by
  environment", and separately said to "move the generation into an importable
  module if needed" and to unit-test "endpoint guessing". Both extractions are
  the smallest way to satisfy those without duplicating code in `plugin/`.
  `pair.ts` and `init-secrets.ts` lost their private copies and gained
  imports; nothing else in them changed.
- `.github/workflows/ci.yml` is **not** edited. It runs
  `bun test shared/src server web/src` literally, so the plugin tests do not
  run in CI until the conductor either adds `plugin` to that line or switches
  it to `bun run test`. The new `server/lib` tests do run.

## Verified

- `bun test plugin server/lib/secrets.test.ts server/lib/endpoint.test.ts`:
  39 pass. Full `bun test shared/src server web/src plugin`: 430 pass, 0 fail
  (bun 1.4.0; `agents.test.ts` passed here, so the EBADF fault did not bite).
- `bun run typecheck` green for all five projects.
- **End to end on this Mac**, with the worktree linked as the plugin, the
  environment exported exactly as herdr injects it, and `PORT=7275` in the
  plugin's config-dir `.env`:
  - `setup` wrote `.env` (mode 0600, passcode printed once), wrote the plist,
    bootstrapped it, and `/api/meta` answered on 7275 within the hook's own
    run — the hook took 0.48s wall clock.
  - `herdr plugin action invoke shahi.status` ran through herdr and reported:
    service running with pid, address, `/api/meta` (herdr 0.8.2, protocol
    20, api 2–2), 0 paired devices, every path. Output in
    `herdr plugin log list --plugin shahi`.
  - `shahi.stop` via herdr: 7275 stopped answering. `shahi.restart` via
    herdr: answering again.
  - The pair verb, run directly with the address typed at its prompt (this
    Mac has no Tailscale): printed the QR, the `shahi://pair#…` URL, server
    and expiry, then "Press Enter to close".
  - `logs` printed the sidecar's log tail.
  - `uninstall` booted the agent out and deleted the plist; `launchctl print`
    then failed and 7275 was dead.
- Two things that run found and that are fixed: `process.execPath` is the
  Homebrew Cellar path a `brew upgrade` deletes, so the service now names
  `Bun.which("bun")` (`/opt/homebrew/bin/bun`); and a hand-made `.env`
  holding only `PORT=` stayed 0644 after the session key was written into
  it, so `writeEnvFile` chmods on every write and `setup` always writes.
- Cleanup: LaunchAgent booted out and plist deleted, the plugin's config and
  state directories removed (they held only what the test created), plugin
  unlinked; `herdr plugin list` says none. No `.env` at any repo root was
  touched; ports 7171/7272/7273/8081 untouched; no popup was opened in the
  owner's live herdr session.

## Not verified

- **Linux / systemd.** Rendered and asserted (`renderSystemd` tests), never
  run against a real systemd. `daemon-reload`, `enable`, `restart`,
  `is-active`, `show -p MainPID` are the commands install.sh already uses,
  so the risk is in details like `StandardOutput=append:` (systemd ≥ 240).
- **The popup itself.** The pane's command was run directly with stdin
  closed / piped; `herdr plugin pane open --plugin shahi --entrypoint pair`
  was not invoked, because a popup is session-modal and would have grabbed
  the owner's terminal. The manifest declares `placement = "popup"`,
  `width = "80%"`, `height = "90%"` per the doc, and herdr accepted it on
  link.
- **`herdr plugin install` from GitHub** — the build steps and the install
  preview. Cannot be exercised until the branch is on GitHub. The build
  commands are the same two install.sh runs.
- **The startup hook fired by herdr itself.** `link` does not run it and I
  did not restart the owner's herdr. It was run by hand with the same
  environment and `HERDR_PLUGIN_EVENT=startup`.

## Decisions to know about

- **`setup` and `restart` are one operation** and always restart the
  service. Rationale in `plugin/shahi.ts`'s header and CLAUDE.md.
- **The plugin never leaves the passcode gate off.** An empty
  `PASSCODE_HASH_B64` gets a passcode on the next herdr start. A checkout can
  still turn the gate off via `init-secrets.ts`.
- **`uninstall` is an action**, not the separate `plugin/uninstall.ts` the
  brief named, because a verb needs herdr's injected environment and an
  action is the only way to get it from a terminal. Same behaviour: removes
  the service, keeps config and state, prints what to delete by hand.
- **The pair popup prompts for the address** when there is no Tailscale name
  and the bind is loopback, instead of pair.ts's "run again with
  --endpoint" — which cannot be done from inside a popup.
- **Service names are fixed** (`app.shahi.sidecar`, `shahi.service`). One
  sidecar per user. On Linux the unit name is the one install.sh writes, so
  the plugin takes over an install.sh service rather than running a second
  sidecar on the same port.

## For the conductor to land it

1. Add `plugin` to the unit-test line in `.github/workflows/ci.yml` (or run
   `bun run test`).
2. After merging to `master` on GitHub, add the repository topic
   `herdr-plugin` so the marketplace lists it. Then `herdr plugin install
   iYassr/shahi` from a clean machine is the first real test of the build
   steps; a Linux box is the first test of the systemd path.
3. Nothing else: no `expo prebuild`, no schema change, no API version bump
   (no route or payload changed).
