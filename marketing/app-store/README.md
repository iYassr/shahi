# App Store screenshots

Seven 6.9-inch frames (1320 × 2868): a headline over the Release app on an
iPhone 17 Pro Max simulator, paired with the stub's `showcase` scenario
(`e2e/stub/showcase.ts`), invented projects and agents, never a real session.
Made for 1.1.2 on 16 October 2026; the 1.0 set had gone stale.

1. Build the Release app for the simulator with signing on
   (`CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM=6H24S2PL9V`): an unsigned build has no
   keychain entitlement and shows "Couldn't save your computers securely", and
   re-signing afterwards fails at launch, because a simulator build carries its
   entitlements from link time.
2. Boot an iPhone 17 Pro Max, `simctl status_bar … override --time 9:41
   --batteryState discharging --batteryLevel 100 …`, dark appearance, and
   `defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false`.
3. `HOSTED_PORT=7572 bun e2e/hosted/server.ts`, then `maestro test flows/pair.yaml`.
4. Post `control.json` to `http://127.0.0.1:7573/__stub/control` (without a
   handshake the app treats the fixture as an old computer and hides Changes),
   then `flows/relaunch.yaml`.
5. Between flows, `xcrun simctl io <udid> screenshot raw/<name>.png`:
   `answer` after relaunch, `agents` after `scroll`, `read` after
   `open-conversation`, `changes` after `changes` + `diff`, `screen` after
   `screen`, `start` after `new-agent` + `pick-space`, and `setup` from a fresh
   launch before pairing.
6. `bun marketing/app-store/render.ts raw out`; `frames.json` holds the words.

The scenario's times are relative to when it is chosen, so restart the fixture
before a run rather than reusing one from an hour ago.
