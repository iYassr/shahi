# Hosted browser client

`https://getshahi.dev/pwa/` distributes the browser application. The sidecar stays
on the user's computer and connects outbound to the relay. The website does not
proxy terminal traffic or hold pairing credentials. The browser runs the same
pairing and encrypted relay protocol as the native app.

Run the plugin's pairing action, scan its QR in the browser app, paste the
`shahi://pair#…` code, or open the browser link printed underneath it. The link
carries the complete native pairing code in its URL fragment, never a query
parameter. A fragment is not sent in HTTP requests or referrers. Treat the
whole link as a secret; it expires after ten minutes and can be claimed once.
Mint a separate code for each browser or native installation.

## Build and publish

```sh
bun run site/build.ts
cd site
bunx wrangler deploy
```

The build writes `site/dist`: the existing marketing and privacy pages plus the
browser bundle under `pwa/`. `site/wrangler.toml` serves that directory. Building
alone does not publish anything. Publishing replaces the current static website
and browser app together. There are no server credentials or environment files
in the output. The browser receives the relay address during pairing.

`bun run build:web` still builds the local sidecar client in `web/dist` with `/`
as its base. Hosted output is independently built in `web/dist-hosted` with
`/pwa/` as its base. Both generated directories are ignored by Git.

The static host explicitly rewrites browser routes to the `/pwa/` application shell; it
returns 404 for unknown paths, including `/api/*`. It must never supply a fake
successful HTML response to an API request. The site is not an HTTP API proxy.

## Browser boundaries

The hosted client requires HTTPS. The site adds a Content Security Policy that
allows bundled scripts, encrypted WebSocket connections, and local image blobs;
it rejects inline scripts, eval, embedding, plugins, and form submissions.
Camera permission is limited to the current origin and the app requests it
only for QR scanning. Referrers are disabled. No third-party scripts should be
added to this origin: code delivered by the website is part of the browser's
trusted computing base.

Service-worker and manifest scopes are `/pwa/`. The service worker caches only
the public application shell and built assets. It skips API paths, files,
requests with authentication headers, query-bearing URLs, and non-GET requests.
Navigation caching fetches the canonical shell instead of storing pane URLs.
Cache cleanup only removes this application's old cache entries. Browser
credentials and terminal/session data must never be placed in Cache Storage.

A browser's storage is isolated by origin, not pathname: `/pwa/` is not a security
boundary from other code at `getshahi.dev`. Keep the marketing website free of
third-party scripts and untrusted active content. E2E encryption protects traffic
from the relay, not from a compromised application host or malicious browser
extension with permission to read this origin.

Validate a release with `bun test plugin/browser-hosting.test.ts`, the browser
suite, and a hosted build. Verify the response headers on `/pwa/` and `/pwa/sw.js`
after publishing, and check pairing, reconnecting, revocation, uploads, and
notifications against an isolated test sidecar before announcing it.

Hosting configuration follows Cloudflare’s [static asset redirects](https://developers.cloudflare.com/workers/static-assets/redirects/) and [response header rules](https://developers.cloudflare.com/workers/static-assets/headers/).

## Security verification

`bun run build:site && bun run test:hosted` exercises the actual hosted bundle
in Chromium and WebKit against an isolated encrypted box fixture. It checks
pairing, fragment removal, explicit credential persistence, reload, logout,
revocation, prompt delivery, files, images, downloads, uploads and camera
cancellation. The browser test refuses every plaintext `/api` request from the
hosted app and every network request outside its fixture origin. It never
connects to a user's herdr session.

The distribution origin remains trusted: a malicious release or compromised
same-origin script could access an unlocked session and remembered credentials.
Browser storage is not a Keychain or a security boundary against JavaScript on
the same origin. The PWA ships no third-party scripts, keeps marketing pages
script-free, and restricts executable content with CSP. IndexedDB persistence
is explicit and intended only for a trusted personal browser profile.

## Verified deployment — 5 September 2026

Published the static site and hosted client to `https://getshahi.dev/pwa/` as
Cloudflare version `ea31ad78-da9a-4ef3-8b6a-3dac08e862d1`. Production onboarding
was inspected in a browser. API routes are not proxied by the website.

Validation: 555 unit tests, four dependency patch tests, 217 native tests,
20 hosted Chromium/WebKit tests, and the local-client browser suite
(176 passed, four skipped). All project type checks and both web builds pass.
A final local Settings/parity check after the notification changes passed seven
checks. Physical-camera permission and real push delivery remain device checks;
automated tests decode a generated plugin QR and verify track cancellation.

The updated clients require API 5. On 2026-09-05 the installed sidecar was
updated from the tested workspace and restarted; its local metadata confirms
API 5, herdr 0.8.2/protocol 20, and a connected relay. Its stale QA-session socket
was corrected to the already-running main herdr session. Existing credentials,
paired devices, and transcripts were preserved; the previous checkout and a
database snapshot were retained for rollback. Legacy unowned notification
registrations were removed, so notifications must be enabled again. The native
client also needs an API 5 build; incompatible clients receive the version gate.
