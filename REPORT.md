# Stream: testing — report

Branch `stream/testing`, four commits on top of `161ca96`.

## What changed

| File | Change |
| --- | --- |
| `mobile/src/screens/pane.test.tsx` | **New.** Ten component tests for the reader, one per named behaviour in the brief plus a failed send and the honest "anchor fell out" counterpart to the restore guard. `@/lib/api` is faked per test (real error classes kept, so `instanceof UnauthorizedError` is the real decision); the session context is a plain object whose `onPaneFrame` a test can fire the way the socket does. Runs on fake timers for the whole file — see the comment for why they cannot be switched mid-file. |
| `mobile/src/lib/api.test.ts` | One test added: the socket handshake carries `x-shahi-api` and the cookie. |
| `mobile/src/lib/api.ts` | **Outside ownership — see below.** The WebSocket now opens with `baseHeaders()` (contract version + cookie) instead of the cookie alone. |
| `e2e/stub/server.ts` | Additive: `POST /__stub/meta` with `{ api: { min, max } }`; `/api/meta` advertises the range; a version gate in the same place and words as the real server's (before auth, before the `/ws` upgrade, only on requests that name a version). Reset by `/__stub/scenario`. |
| `.maestro/update-needed.yaml`, `.maestro/stub/set-meta.js`, `.maestro/stub/reset.js` | **New.** The flow, and the two `runScript` helpers it uses to drive the stub over HTTP. `onFlowComplete` resets the stub whatever happens. |
| `server/lib/herdr-live.test.ts` | One `describe.skipIf(!LIVE_AGENT)` test behind `SHAHI_HERDR_LIVE_AGENT=1`: `startAgentInTab` starts a claude in the scratch workspace, `submitPrompt` must return `"agent"`, and the prompt must appear on the agent's screen. How to run it is in the file header. |

## Verified, and how

- `bun run typecheck` — green (all four projects).
- `bun run test:mobile` — 15 suites, **109 tests**, green (was 14 / 98). ~1.6s.
- `bun test shared/src server` — **315 pass, 25 skip, 0 fail**. The known `installedAgents` EBADF fault did not trip on this run.
- The reader tests were checked by mutation: dropping the empty-messages guard in `restore()`, the `coalesce`, the 401 branch, the concurrent requests, or the echo retirement fails exactly the test named for it and nothing else (five mutations, five single failures).
- The pane suite was run three times in a row after the timer fix: no `act()` warnings, no open handles.
- The stub's meta control was exercised by hand with curl against a stub on port 7399: default range `{1,1}`; `{2,2}` gives 426 "Update the app" on `/api/session`, on `/api/auth/login` and on the `/ws` upgrade; a header-less request (the archived web client) passes; `{0,0}` gives "Update Shahi on this computer"; a bad body is 400; `/__stub/scenario` resets the range.
- `server/lib/herdr-live.test.ts` under no env: 25 skipped (24 + the new one), 0 fail.

## Not verified

- **`.maestro/update-needed.yaml` has not been run** — Maestro cannot run here. It was read against the existing flows for every command shape it uses (`launchApp` with and without clearing, `extendedWaitUntil`, `tapOn` by id and by text, `assertNotVisible`, `runScript` with `file`/`env` and in short form, `onFlowComplete`). Two things to watch on the first real run: that Maestro's JS environment exposes `http.post` and `JSON.stringify` in a `runScript` file (documented, but not seen here), and that the relaunch in the third part lands on "Update needed" within the 20s wait — it depends on the socket header change below being in the build.
- **The live-agent test has not been run**, by instruction. Its one speculative piece: if herdr reports the freshly started claude as `blocked` and the screen mentions "trust", it sends Enter to accept claude's trust question on the test's own empty temp directory. If claude's first screen is something else, the test fails naming the pane rather than printing its screen (per the "never log pane.read output" rule).
- The browser suite (`bun run test:e2e`) was not run. The stub change is additive and the default range is what the web client already met; the gate only fires on a request that names a version outside the range.

## Change outside ownership

**`mobile/src/lib/api.ts`, one line plus a comment** — the WebSocket handshake now sends `x-shahi-api` (via `baseHeaders()`) rather than the cookie alone.

Why it was necessary rather than convenient: the flow's third part asserts a signed-in app meeting a 426 shows "Update needed". Without the header, the real server (and a faithful stub) refuses `/api/session` but still upgrades the socket and pushes a session snapshot, and `Agents` shows the `Unreachable` screen only while `session` is null — so "Update needed" appears for a frame and is replaced by a live list from a server every tap on which answers 426. The flow could not assert a state the product could not hold. CLAUDE.md already says every request carries the header; this makes the socket honour that. The real server's gate already sits before the upgrade, so no server change is needed. If the conductor would rather not take a product change from this stream, the flow's third part must go with it.

## For the conductor

- Nothing to prebuild; no native module or dependency changed. The api.ts change needs a JS bundle in the simulator build the flow runs against.
- Docs that now understate the count, outside my ownership: CLAUDE.md says "ten Maestro flows in `.maestro/`" and "fourteen unit suites" (now eleven and fifteen), and its "What is not done" bullet *"`agent.prompt` is not exercised against a real agent in CI"* can now point at `SHAHI_HERDR_LIVE_AGENT=1`; `docs/on-a-mac.md` says "Ten flows today".
- The mobile scratch stub port used for the curl check was 7399, chosen to stay clear of the reserved ports; nothing was left running.
