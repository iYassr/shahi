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

Add a native module or change `app.json`, and the native project has to be built
again: `npx expo run:ios` handles that too.

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

Two flows today. One signs in, crosses the tab bar both ways and opens a pane —
the route restructure and the native tab bar, which nothing else can verify. The
other opens New agent and checks every claude permission mode is offered,
because getting that wrong means an agent runs with flags nobody chose.

`maestro studio` opens an inspector against the running app, which is the
fastest way to write the next flow: it shows you the selectors that exist rather
than the ones you hoped for.

## Everything else runs here too

```sh
bun test shared/src server web/src   # 313, no device
bun run test:mobile                  # 18 component tests, no simulator
bun run test:e2e                     # 164 browser tests, both engines
```

The last one needs `bunx playwright install chromium webkit` first.

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
