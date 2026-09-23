# Working on this from a Mac

The server lives on the Ubuntu box; the app is built and tested wherever there
is an Xcode. This is the second one.

The whole reason to bother: **a Mac makes the iOS tests free.** Simulator runs
are gated behind a paid EAS plan in Expo's cloud, and behind nothing at all
against a simulator on your own machine: the Maestro flows in `.maestro/`, the
Maestro runs in `e2e/native/` and the XCUITest harness in `mobile/uitests/` all
run here, and none of them runs in CI.

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

The app has no typed-address sign-in: it reaches a computer by a relay pairing
code or over SSH. Two choices, and the second is usually the right one.

**A real computer**: pair with `herdr plugin action invoke shahi.pair` on it.
The simulator has no camera, so show the code as text (T then Enter in the
popup) and open the `shahi://pair#…` code in the simulator with
`xcrun simctl openurl booted '<code>'`; the app asks you to confirm first. Or
connect over SSH with the passcode. Live agents, real transcripts, and every
keystroke you send is real.

**The encrypted fixture**, for anything you would rather not do to a live
session:

```sh
HOSTED_PORT=7874 bun e2e/hosted/server.ts     # from the repo root
```

It is a relay and a sidecar in one process, speaking the real encrypted
protocol to the app, with the browser suite's stub behind it (on
`HOSTED_PORT` + 1), so writes are recorded rather than performed.
`POST /__hosted/reset` mints a single-use pairing code; the scripts in
`e2e/native/` call it and open the code in the simulator themselves. The
simulator shares the Mac's network stack, so `127.0.0.1` is the Mac.

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
The other scripts in `e2e/native/` follow the same shape. For checks that need
an element's position or precise gestures, the XCUITest harness in
`mobile/uitests/` drives the installed app; its README says how to run it
against the same fixture.

The runs drive the app with Maestro:

```sh
curl -Ls "https://get.maestro.mobile.dev" | bash      # once
```

Two things the first local runs taught:

- The `expo run:ios` build has no embedded bundle — Metro must be running or
  the app opens on a red "No script URL provided" screen. Launch the app once
  by hand before a run, so the first flow is not racing a cold bundle
  compile.
- Maestro's iOS driver sometimes wedges between runs and the next run dies
  with "iOS driver not ready in time". `pkill -9 -f maestro-driver-iosUITests`
  clears it; a simulator that has stopped answering `simctl` needs a shutdown
  and boot.

### The flows in `.maestro/`

Eight flows, each arriving the way a phone does — it opens a `shahi://pair`
code from the recording fixture and confirms it — so nothing real is on the
other end: answering a cursor menu, the list's filters, pinning, a reply that
shows at once, Settings' sign-out and back in, the permission picker's
cautions, a computer that cannot be reached, and "Update needed". From the
repository root, in two terminals:

```sh
HOSTED_PORT=7572 bun e2e/hosted/server.ts     # the fixture also takes 7573
maestro test .maestro/
```

7572 is the flows' default, and the hosted Playwright config binds it too, for
its second computer. To run beside that suite, start the fixture on another
port and pass `-e FIXTURE_PORT=<port>`. With a Release build installed the
flows need no Metro. `reply-shows-at-once` needs the software keyboard: turn
off Simulator → I/O → Keyboard → Connect Hardware Keyboard, or the keyboard
never rises.

They run locally or by hand only; nothing in CI boots a simulator.
`mobile/.eas/workflows/ios-e2e.yml` would run them on EAS against the same
fixture, but only when started by hand, and its Maestro job needs a paid plan.
What does run everywhere is `server/lib/native-flows.test.ts`, in `bun run
test`: it reads every flow and XCUITest the way the runner would and fails on
an element id the app does not set, text neither the app nor the fixture can
show, or a script that is gone. The thirteen flows before these all signed in
through a typed-address screen the app had lost, and nothing noticed until
someone ran them.

`maestro studio` opens an inspector against the running app, which is the
fastest way to write the next flow: it shows you the selectors that exist rather
than the ones you hoped for.

## Everything else runs here too

```sh
bun run test                         # unit, workflow-policy and dependency checks, no device
bun run test:mobile                  # unit and component tests, no simulator
bun run test:e2e                     # browser tests, both engines
```

Use `bun run test` rather than a hand-typed `bun test` list: it includes
`./.github`, which bun would skip without the `./`.

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
test_config_root=$(mktemp -d /tmp/shahi-live.XXXXXX)
XDG_CONFIG_HOME="$test_config_root" herdr --session shahi-ci server &
export HERDR_SOCKET_PATH="$test_config_root/herdr/sessions/shahi-ci/herdr.sock"
SHAHI_HERDR_LIVE=1 bun test server/lib/herdr-live.test.ts
XDG_CONFIG_HOME="$test_config_root" herdr session stop shahi-ci
unset HERDR_SOCKET_PATH
```

Keep the root under `/tmp`. A plain `mktemp -d` here lands under `$TMPDIR`
(`/var/folders/…/T/`), which makes the session's `herdr-client.sock` path 105
bytes — over the 104 a macOS socket address holds — and herdr refuses to start.

The suite refuses to run otherwise (`server/lib/herdr-live-guard.ts`): a socket
that is not a named session's, and a session holding the pane the test runs in.
Inside a herdr pane `HERDR_SOCKET_PATH` is already set, to that pane's own
session, so the variable alone once proved nothing.

The `installedAgents` detections in `server/lib/agents.test.ts` used to fail
here intermittently with agents resolving to nothing: under bun's test runner a
spawned child's stdout pipe could be handed an invalid descriptor. Discovery
now has the shell write to a private temporary file instead, and the whole
file passed on this Mac with bun 1.4.0 on 2026-09-23.

## What not to do

**Never point the browser suite at the live server for anything that writes.**
That mistake typed into somebody's session once already, and a Mac on the tailnet
is exactly where it would happen again.

### Reader checks against a real server

`e2e/native/read-live-conversation.yaml` is a read-only flow for an already
paired simulator. Open a real long conversation at its latest message first.
Pass its pane ID, final message ID, and an older message ID outside the initial
60-message page. Choose a short older message so it can fit on screen. For
Codex and Cursor panes the message IDs are scoped to their transcript
(`<sessionId>:codex-<row>`, `<sessionId>:cursor-<n>`); copy them from the
current sidecar, because IDs from a sidecar before that change will not match.

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
