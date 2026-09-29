# Requiring a frontend update

The iPhone and hosted browser app check `https://getshahi.dev/api/client-update`
at launch, on returning to the foreground, and once a minute while active.
This lives on the website Worker, independently of the computer service and
relay. It works when a backend regression prevents normal app requests.
No pairing secrets, conversations, device identifiers or cookies are sent.

The default `site/client-update.json` disables both requirements. A policy is
data, never downloadable code: it can require a build and display a short
message, but cannot supply a URL or command. iPhone update links are compiled
into the app. This needs no paid Expo plan and does not install an iOS binary
without the person's action.

## Enable after the replacement is available

1. Publish and verify the replacement first. For iOS, verify availability for
   **every affected App Store and TestFlight user**, including external beta
   review and tester groups. The iOS floor applies to both channels; never
   require a TestFlight-only build from App Store users. Keep iOS build numbers
   increasing across marketing versions. The web floor compares
   `WEB_CLIENT_BUILD` in `shared/src/client-update.ts`; increase it before
   publishing a browser release that will be required.
2. Prepare the policy, for example (28 is illustrative):

   ```sh
   bun scripts/client-update.ts ios 28 24 "This update fixes conversation loading."
   # Or require a hosted browser build:
   bun scripts/client-update.ts web 2 24 "Reload Shahi to restore your connection."
   ```

3. Review `site/client-update.json`, run `bun run test` and `bun run build:site`,
   then deploy using the normal website workflow. Setting the policy does not
   require publishing or restarting the computer service. Verify the public
   endpoint and an older disposable client after deployment.

The app shows a blocking update screen. An iPhone user opens App Store or
TestFlight; a browser user explicitly reloads. The gate leaves the underlying
screen mounted and never automatically reloads a draft or repeats a send.
An explicit reload can discard in-memory drafts and attachment selections; the
browser warns before doing so. Saved computers remain saved; a browser paired
without remembering its credentials still needs to pair again after reload.
The browser checks that a different bundle is actually served before reloading,
so an early policy cannot cause an automatic reload loop. Locally served web
clients keep their computer service's existing compatibility/update controls.

## Undo or recover

```sh
bun scripts/client-update.ts ios clear
bun scripts/client-update.ts web clear
```

Deploy that policy. **Check again** bypasses the one-minute throttle and removes
the gate immediately after a valid disabled policy arrives. A cached requirement
survives network failures, malformed responses and app restarts until its stated
expiry. Requirements expire automatically and cannot be issued for more than
14 days at a time. With no valid policy, the app remains available; a website
outage alone never forces an update. Unknown/development builds are not gated.

This is operational recovery, not a security boundary or permission to break
API compatibility. Keep supporting the current and previous API generations for
the documented release window. Apps released before this gate shipped cannot
receive it retroactively; they retain the existing API incompatibility notice.
