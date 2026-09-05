# Audit against the official `expo/skills`

> Historical review. Findings and test counts refer to the revision reviewed,
> not necessarily the current release. See the [documentation index](README.md)
> for maintained guides and later assessments.

Shahi's `mobile/` app audited against Expo's official agent-skill collection
([github.com/expo/skills](https://github.com/expo/skills)) on 2026-08-13. Four
skills were run as focused audits: `expo-module`, `eas-app-stores`,
`expo-router` + `expo-project-structure`, and `expo-data-fetching`.

The headline: the Expo-facing surface is in good shape — the native module uses
the Modules API correctly, `src/app/` is routes-only, the network layer checks
`response.ok` everywhere and stores the cookie in the Keychain. Every finding
below is a specific deviation, and the four **high-severity** ones were all real
bugs. Those, plus the cheap and unambiguous mediums, are **fixed**; the rest are
recorded here as prioritised follow-ups rather than silently dropped.

## Fixed

| Sev | Finding | Where | Commit |
|-----|---------|-------|--------|
| HIGH | Photo attach had no `NSPhotoLibraryUsageDescription` — a hard crash on tap and an ITMS-90683 rejection. Added the `expo-image-picker` plugin with a purpose string (verified via `expo config --type introspect`). | `mobile/app.json` | `bebc043` |
| HIGH | A 401 while polling an open pane was swallowed as "no transcript", leaving a dead pane that polled 401 forever while the header claimed LIVE. Now routes `UnauthorizedError` to `signOut`. | `mobile/src/screens/pane.tsx` | `b7fdc87` |
| HIGH | A notification tap that cold-launched the app was lost — the response arrives before the (post-auth-gate) listener attaches — so it landed on the list, not the pane. Now caught with `getLastNotificationResponseAsync`, cleared after routing, and gated on `connected`. | `mobile/src/lib/push.ts`, `app/(tabs)/agents/index.tsx` | `1bd6274` |
| HIGH | `stop` freed the libssh2 session while the select loop was still reading it — a use-after-free on **every** tunnel close (libssh2 sessions are not thread-safe). Now `stop` waits on a semaphore the loop signals as it exits before freeing anything. | `mobile/modules/ssh-tunnel/ios/SshForwarder.m` | `6d2d532` |
| MED | `libssh2_channel_write` returning `EAGAIN` on a congested uplink was re-called in a tight loop, pinning a core. Now blocks on the session socket until it drains. | `SshForwarder.m` | `6d2d532` |
| MED | `readFile` and `upload` used raw `fetch` with no timeout — a dead host hung the file viewer / an upload forever. Both routed through `fetchWithTimeout` (uploads get 60s). | `mobile/src/lib/api.ts` | `b7fdc87` |
| MED | An internal `expo-router/build/react-navigation/elements` import (liable to break on a patch bump) moved to the public `expo-router/react-navigation` entry. | `mobile/src/screens/pane.tsx` | `b7fdc87` |

## Follow-ups (recorded, not yet done)

Ordered roughly by value. None are crashes; they need either design judgement or
device verification, so they were left for a deliberate pass.

### Native SSH module
- **MED — blocking `connect()` has no timeout** (`SshForwarder.m`, `connectSocketTo:`).
  A routable-but-unreachable host blocks ~75s (OS default) before the `open`
  promise rejects, undercutting `tunnel.ts`'s prompt "unreachable" message. Fix:
  non-blocking connect with a bounded `select`, then restore blocking for the
  handshake.
- **MED — Swift `forwarder`/`tunnel` mutated across threads** (`SshTunnelModule.swift`).
  The completion block (Tunnel queue) can nil these while a subsequent `open`
  (module thread) touches them. JS serialises calls so the common path is safe,
  but confine all mutation to the one serial queue given libssh2's thread
  sensitivity.
- **LOW — no `OnAppEntersBackground`/foreground reaction.** iOS suspends the
  process and the OS tears down the SSH sockets; the tunnel dies silently with
  no reconnect. If reconnect is meant to live in JS, say so in a comment.
- **LOW — `opened.hostKey as Any`** in the resolve dictionary is a smell; a
  successful `start()` always has a fingerprint, so make it non-optional.

### Router / structure
- **MED — the auth gate mounts the tab bar before redirecting.** `app/index.tsx`
  unconditionally `<Redirect href="/agents" />`, so `(tabs)/_layout` → `NativeTabs`
  is constructed and flashes before `agents/index` redirects a signed-out user to
  `/connect` — contradicting the root layout's stated intent that "the tabs are
  never constructed before there is a session." Branch on session state in
  `app/index.tsx` (or gate at `(tabs)/_layout`). *Worth checking whether this
  relates to the unresolved refresh/blank-screen report.*
- **MED — no `<Link>` / `Link.Preview` / `Link.Menu`** anywhere; every row is
  `Pressable` + imperative `router.push`. The skill pushes `<Link asChild>` with
  peek/preview and long-press context menus for exactly these list rows. An
  enhancement, not a bug.
- **LOW — camelCase dynamic-route filenames** (`[paneId]`, `[workspaceId]`) vs the
  skill's kebab-case rule. Cosmetic; renaming ripples through `lib/navigate.ts`.

### Data fetching
- **MED — the transcript poll writes state after unmount.** `load()` in
  `pane.tsx` never checks the effect's `cancelled` flag before its ~6 `setState`
  calls, and the fetch isn't aborted — an in-flight tick that resolves after the
  screen is popped still runs them. The sibling `FileViewer` already guards with
  a `live` flag; the poll loop should match, ideally by threading an optional
  `signal` through `request`/`fetchWithTimeout` (which would also let the file
  viewer abort in flight).
- **LOW — new-agent sheet fetches inside `useMemo`** (`spaces.tsx`) — a side
  effect in a memo, no unmount guard, no `.catch`. Move to `useEffect` with a
  `live` guard.
- **LOW — concurrent `load()` invocations** (`chase()` vs the interval tick) race
  on `messagesRef.current`. `merge` is pure so no data is lost; the identity
  fast-path can be defeated. Benign; gate `chase` or add a comment.

## What the audit confirmed was already right
- Modules API/DSL usage is idiomatic (`Name` matches the JS resolver, the Swift
  class is in `expo-module.config.json`, `OnDestroy` cleans up).
- `src/app/` is routes-only; thin route files delegate to `src/screens/*` exactly
  as `expo-project-structure` prescribes.
- Version management (`appVersionSource: "remote"` + `autoIncrement`), build-profile
  distribution, `expo-notifications`/`expo-secure-store` plugins, and the new
  Icon Composer `.icon` asset are all correct for submission.
- WebSocket lifecycle, cookie handling (`credentials: "omit"` on every request),
  and `useCallback` stability in the poll loop are clean — no leaks, no stale
  closures.

## Human / account items (unchanged from `app-store.md`)
Apple Developer membership + App Store Connect record for `app.shahi.mobile`
(also unblocks the empty `submit.production` profile in `eas.json`), hosted
privacy policy, App Privacy labels, screenshots + description, on-device proof of
push, and a VoiceOver pass.
