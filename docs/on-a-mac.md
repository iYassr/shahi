# Working on this from a Mac

The server lives on the Ubuntu box; the app is built and tested wherever there
is an Xcode. This is the second one.

The whole reason to bother: **a Mac makes the iOS tests free.** The Maestro flows
in `.maestro/` are gated behind a paid EAS plan when they run in Expo's cloud,
and gated behind nothing at all when they run against a simulator on your own
machine.

## Once

```sh
git clone https://github.com/iYassr/shahi.git && cd shahi
bun install
```

Xcode from the App Store, then `xcode-select --install` and open it once to
accept the licence. `bun` via `curl -fsSL https://bun.sh/install | bash`.

**Install from the repo root, not from `mobile/`.** This is a workspace: the
app's dependencies are hoisted to the root, and installing from inside `mobile`
gives you a second, partial copy of them. If Expo's CLI reaches for npm — it
does when it cannot see a lockfile beside the project — that is fine now, but
bun is what the lockfile is for.

## Run the app

```sh
cd mobile
npx expo run:ios          # builds natively, installs to a simulator, hot reloads
```

The first run compiles the native project and takes a while; later runs are
quick, and JavaScript edits arrive without a rebuild. This is the loop worth
having — an EAS build is five minutes and this is a save away.

Add a native module or change `app.json`, and the native project has to be
regenerated *and* built again:

```sh
npx expo prebuild --platform ios && npx expo run:ios
```

`run:ios` alone does not re-read `app.json` once `ios/` exists. Measured: a
build made that way still had `NSAllowsArbitraryLoads` false, so every plain
`http://` address except localhost was refused by App Transport Security, and
an afternoon went to a "TLS" error on a server with no TLS.

### Building with Xcode 27

iOS 27 requires the scene lifecycle for apps built with its SDK. Shahi enables
it through the `expo-build-properties` plugin in `app.json`, using Expo
57.0.23 or later. Regenerate the native project after pulling this change;
an older generated AppDelegate compiles but the app exits at launch.
See [Expo's scene lifecycle guide](https://github.com/expo/fyi/blob/main/ios-scene-lifecycle.md).

Keep simulator code signing enabled (ad hoc signing is sufficient). Disabling
signing prevents secure storage from accessing the simulator keychain, so
pairing can connect without saving the computer successfully.

## Give it something to talk to

Two choices, and the second is usually the right one.

**The real server**, if the Mac is on the tailnet: enter
`https://<your-host>.<your-tailnet>.ts.net` and the passcode. Live agents, real
transcripts, and every keystroke you send is real.

**The stub**, for anything you would rather not do to a live session:

```sh
PORT=7272 bun run e2e/stub/server.ts     # from the repo root
```

Then connect to `http://localhost:7272` with passcode `1234`. The simulator
shares the Mac's network stack, so localhost is the Mac. This is the same stub
the browser suite uses — the same contract, the same fixtures, and writes are
recorded rather than performed.

## Run the iOS tests

The relay-based creation matrix covers both entry points (Agents and Spaces),
each recognized agent kind, and every permission mode Shahi offers. It asserts
that creation opens a conversation and sends exactly one request with the
selected kind, space, and permissions. The fixture creates synthetic panes;
this checks the app contract, not whether every CLI is installed locally.

With a release build installed on a booted simulator, run these in separate
terminals from the repository root:

```sh
HOSTED_PORT=7874 bun e2e/hosted/server.ts
SIMULATOR_UDID=<device-id> HOSTED_PORT=7874 bun e2e/native/creation-matrix.ts
```

Use `AGENT_KINDS=claude,codex,cursor,agy` to narrow a diagnostic run. Artifacts
are saved in the temporary directory printed by the runner. Pairing is reset
for this synthetic computer. Never substitute a real server for the fixture.

The older `.maestro/` flows below still use the retired typed-address onboarding
and need migration before they can run against the current app.

```sh
curl -Ls "https://get.maestro.mobile.dev" | bash      # once
```

With the app installed on a booted simulator and the stub running:

```sh
maestro test .maestro/
```

Two things the first local run taught:

- The `expo run:ios` build has no embedded bundle — Metro must be running or
  the app opens on a red "No script URL provided" screen. Launch the app once
  by hand before `maestro test`, so the first flow is not racing a cold bundle
  compile.
- Maestro's iOS driver sometimes wedges between runs and the next run dies
  with "iOS driver not ready in time". `pkill -9 -f maestro-driver-iosUITests`
  clears it; a simulator that has stopped answering `simctl` needs a shutdown
  and boot.

Eleven flows today, all against the stub. The first signs in, crosses the tab bar
both ways and opens a pane — the route restructure and the native tab bar,
which nothing else can verify. Another opens New agent and checks every claude
permission mode is offered, because getting that wrong means an agent runs with
flags nobody chose. `cannot-reach-the-server.yaml` needs no stub at all: it
connects to a name that cannot resolve and to a port with nothing behind it,
and checks the words that come back name the address and not a Swift file.

`maestro studio` opens an inspector against the running app, which is the
fastest way to write the next flow: it shows you the selectors that exist rather
than the ones you hoped for.

## Everything else runs here too

```sh
bun test shared/src server web/src   # 313, no device
bun run test:mobile                  # unit and component tests, no simulator
bun run test:e2e                     # 164 browser tests, both engines
```

The last one needs `bunx playwright install chromium webkit` first.

The live suite against a real herdr runs here too, and this Mac has one. Run
it against a **named session**, never a bare socket override: a second server
started with only `HERDR_SOCKET_PATH` restores your default session's saved
state and re-launches its agents as duplicates (four extra `claude --resume`
processes, measured). A named session has its own directory and starts empty.

A named session isolates panes, **not installed startup hooks**. Always use a
fresh `XDG_CONFIG_HOME` as well, so no plugins are installed in the test
configuration. On 2026-09-18, starting a named session under the normal config
ran Shahi’s startup hook and repointed the production service at the test
socket. Keep the normal `HOME` so installed agents remain available; do not
copy plugins into the test configuration. Use the same configuration root when
stopping the named session.

```sh
test_config_root=$(mktemp -d)
XDG_CONFIG_HOME="$test_config_root" herdr --session shahi-ci server &
export HERDR_SOCKET_PATH="$test_config_root/herdr/sessions/shahi-ci/herdr.sock"
SHAHI_HERDR_LIVE=1 bun test server/lib/herdr-live.test.ts
XDG_CONFIG_HOME="$test_config_root" herdr session stop shahi-ci
unset HERDR_SOCKET_PATH
```

Two of the unit tests — the `installedAgents` detections in
`server/lib/agents.test.ts` — can fail here with agents resolving to nothing.
Measured on macOS 27.0 with bun 1.3.14: under `bun test` a spawned child's
writes to its stdout pipe fail (the same child writes files fine, and the same
spawn under `bun -e` works), and it comes and goes across minutes. That is a
bun test-runner fault, not a detection bug; the same tests pass on the Ubuntu
box and in CI.

## What not to do

**Never point the browser suite at the live server for anything that writes.**
That mistake typed into somebody's session once already, and a Mac on the tailnet
is exactly where it would happen again.

### Reader checks against a real server

`e2e/native/read-live-conversation.yaml` is a read-only flow for an already
paired simulator. Open a real long conversation at its latest message first.
Pass its pane ID, final message ID, and an older message ID outside the initial
60-message page. Choose a short older message so it can fit on screen.

```sh
maestro --device SIMULATOR_ID test \
  -e PANE_ID=YOUR_PANE_ID \
  -e LAST_MESSAGE_ID=YOUR_LAST_MESSAGE_ID \
  -e OLDER_MESSAGE_ID=YOUR_OLDER_MESSAGE_ID \
  e2e/native/read-live-conversation.yaml
```

It loads earlier history, switches Read/Screen, leaves and reopens the
conversation, and checks that Latest reaches the actual final message. It sends
no prompts, keys, or approvals. Compare `before-leaving`, `after-toggle`, and
`after-reopening` screenshots for paragraph alignment; keep those screenshots
private because they contain the real conversation. This flow intentionally
lives outside the stub suite.

Verified on 2026-09-18 with the signed Release build in the iPhone 18 Pro /
iOS 27 simulator, connected to the actual Ubuntu sidecar (herdr 0.9.0):
Claude with 1,763 messages and Codex with 284 messages. Both reached their
server-reported final message; settled before/after screenshots had identical
reading-area pixels when reopening, and Claude also matched across Read/Screen.
Earlier-history loading and jumping back to the final message were exercised
on the Claude conversation. No agent input was sent. The final checks used an
SSH tunnel carrying unchanged encrypted relay frames because this Mac could
no longer reach the relay edge directly; the relay and sidecar were real.
