# Shahi — mobile

An Expo app over the same server the web client uses, importing the same wire
contract from `@shahi/shared`.

```sh
bun install                 # from the repo root
bun run --cwd mobile start  # then scan the QR with Expo Go
```

On first run it asks for the server address and passcode. Unlike the web client
there is no origin to infer from, and no browser cookie jar, so both are held by
the app.

## Monorepo notes

`metro.config.js` has to be explicit about two things Metro does not infer:
`watchFolders` must include the repo root, or edits to `shared/` never trigger a
reload and the app silently runs against a stale contract; and
`nodeModulesPaths` must list both the app's own modules and the root's, because
Bun hoists most dependencies while leaving some in the workspace.

`@shahi/shared` is TypeScript source rather than a built package. It is types
only, so Metro erases it and there is nothing to build, publish or keep in sync.

## What is done, and what is not

Working and verified against the live server: the API client (auth, session,
reader, agents, RPC), and the Agents screen with blocked-agent cards and
one-tap answers.

Not yet built:

- **Spaces**, the pane detail view, the reader, and attachments.
- **The terminal.** xterm.js has no React Native port; the technique is to run
  it inside `react-native-webview`, as [fressh](https://github.com/EthanShoeDev/fressh)
  does. `@fressh/react-native-xtermjs-webview` exists but pins `react` and
  `react-native-webview` to exact versions that conflict with this SDK, so it is
  a reference rather than a dependency.
- **Push notifications**, which are the strongest argument for the native app:
  the web client cannot deliver them over plain HTTP, since a service worker
  needs a secure context.

Unverified rather than known-good: the WebSocket attaches the session cookie via
React Native's three-argument constructor. That form is not supported by Bun, so
it could not be exercised from the server host — the server side is confirmed
working, but this specific call needs a device or simulator.
