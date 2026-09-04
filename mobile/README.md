# Shahi — mobile

The native app: an Expo app over the same sidecar, importing the same wire
contract from `@shahi/shared`. This is the product; `web/` is archived.

```sh
bun install            # from the repo root
bun run test:mobile    # unit and component tests, no simulator needed
```

**Expo Go cannot run this app.** It has a custom native module
(`modules/ssh-tunnel`, which bundles libssh2 and OpenSSL), so it needs a
development build. See [`docs/on-a-mac.md`](../docs/on-a-mac.md) for building
one and running it on a simulator or a device — that document is also where the
iOS tests are free rather than behind a paid EAS plan.

On first run the app asks how to reach a server: scan a pairing code, or enter
an address and passcode. Unlike the web client there is no origin to infer from
and no browser cookie jar, so the app holds both.

## Monorepo notes

`metro.config.js` has to be explicit about two things Metro does not infer:
`watchFolders` must include the repo root, or edits to `shared/` never trigger a
reload and the app silently runs against a stale contract; and
`nodeModulesPaths` must list both the app's own modules and the root's, because
Bun hoists most dependencies while leaving some in the workspace.

`bunfig.toml` at the root pins the hoisted linker for the same family of
reasons: an iOS build may contain only one copy of any native module, and the
default isolated layout produced duplicates that `expo-doctor` flagged. EAS
installs from that lockfile, so the layout it produces has to be the one that
builds.

`@shahi/shared` is TypeScript source rather than a built package, so Metro
compiles it with everything else and there is nothing to build or publish. It is
not types-only — `shared/src/e2e.ts` is the end-to-end crypto the relay
transport depends on, and it runs on the phone.

## What is not done

- **The terminal.** xterm.js has no React Native port; the technique is to run
  it inside `react-native-webview`, as [fressh](https://github.com/EthanShoeDev/fressh)
  does. `@fressh/react-native-xtermjs-webview` exists but pins `react` and
  `react-native-webview` to exact versions that conflict with this SDK, so it is
  a reference rather than a dependency.
- **Push, on a real device.** The code is complete — a Settings toggle registers
  an Expo token, the server sends on the transition to `blocked`, and a tapped
  notification routes to its pane. The simulator reports
  `Device.isDevice === false` and refuses to mint a token, so this can only be
  proven on an iPhone. See [`docs/notifications.md`](../docs/notifications.md).
- **The recorded-terminal history view**, which exists only in the archived PWA.

Everything this file used to list as unbuilt — Spaces, the pane detail view, the
reader, attachments — shipped some time ago.
