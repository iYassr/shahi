# Hosted browser client

`https://getshahi.dev/pwa/` distributes the browser application. The sidecar stays
on the user's computer and connects outbound to the relay. The website does not
proxy terminal traffic or hold pairing credentials. The browser runs the same
pairing and encrypted relay protocol as the native app.

Run the plugin's pairing action, then scan its QR in the browser app, paste the
`shahi://pair#…` code, or press T then Enter in the popup to show the code as a
`https://getshahi.dev/pwa/#pair=…` link and open that. The link carries the
complete native pairing code in its URL fragment, never a query parameter. A
fragment is not sent in HTTP requests or referrers. Treat the whole link as a
secret; it expires after ten minutes and can be claimed once. Mint a separate
code for each browser or native installation.

A browser opened on a `#pair=` link does not pair from it directly. It shows a
**Connect this browser?** card: "A link is asking to connect this browser to a
Shahi computer. Only continue if you opened this link yourself, from a computer
you control.", the relay's host, the first 16 characters of the computer's
identity, a **Connect to <relay host>** button and **Cancel**, which discards
the code. A malformed link shows its error and only Cancel. Anyone can send
such a link for a computer of their own, and before this card it opened onto a
filled-in form one tap from attaching the browser to that stranger's computer.
Pasted and scanned codes pair as before.

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
returns 404 for unknown paths, including `/api/*`. Those 404s carry the site's
"Page not found" page (`site/public/404.html`, with its own CSP in a meta tag)
rather than an empty body; still a 404, never a fake success. It must never
supply a successful HTML response to an API request. The site is not an HTTP
API proxy.

Caching, from `site/public/_headers`: every unhashed file under `/pwa/`,
including each app route rewritten to the shell, is `no-cache`, so a browser
revalidates it; `/pwa/assets/*` is
`public, no-transform, max-age=31536000, immutable`; `/pwa/sw.js` is
`no-store`. The rule once named `/pwa/` alone, and since header rules match
the requested path rather than the rewrite behind it, `/pwa/pane/*` and every
other app route were served the same HTML with nothing telling a cache to
revalidate it.

## Browser boundaries

The hosted client requires HTTPS. The site adds a Content Security Policy that
allows bundled scripts, encrypted WebSocket connections, and local image blobs;
it rejects inline scripts, eval, embedding, plugins, and form submissions.
Camera permission is limited to the current origin and the app requests it
only for QR scanning. Referrers are disabled. No third-party scripts should be
added to this origin: code delivered by the website is part of the browser's
trusted computing base.

The whole `getshahi.dev` origin loads no third-party resources. Its fonts are
IBM Plex subsets served from `/fonts/`, with IBM's OFL licence beside them;
they came from Google Fonts until the pre-public-release review, which handed
every visitor's address to Google for the sake of a typeface. The marketing
and privacy pages' CSP allows fonts and styles only from `'self'`.

Service-worker and manifest scopes are `/pwa/`. The service worker caches only
the public application shell and built assets. It skips API paths, files,
requests with authentication headers, query-bearing URLs (except the
notification route, which gets the canonical shell), and non-GET requests.
Navigation caching fetches the canonical shell instead of storing pane URLs.
Browser credentials and terminal/session data must never be placed in Cache
Storage.

Each release has its own cache, named after a hash of every file the release
ships, which `web/sw-build.ts` stamps into `sw.js` at build time; there is no
hand-bumped version. Installing a release precaches every file it ships,
lazily loaded chunks included (the terminal, the PDF viewer and pdf.js's
worker, about 2.7 MB uncompressed), so a page left open across a deploy can
still open the terminal or a PDF. Activation keeps the newest earlier complete
release for pages still running it and deletes older ones, so at most two
releases are cached, and never another application's caches on the same
origin. Navigations try the network for 1.5 seconds before falling back to the
cached shell. A lazily loaded chunk that still fails to load shows a "could not
be loaded" notice with Try again in place of the error screen; if the server
names a newer bundle, the update banner appears instead.

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

## Drafts, uploads and recovery

Drafts and pending-send identifiers remain in page memory, scoped to the
computer and pairing grant. Switching conversations or computers preserves
them within the bounded draft cache; reloading the page clears them. Logout and
revocation clear that connection’s drafts. The service worker does not persist
conversation data or drafts.

Because a reload would lose them, the automatic update waits while any
conversation in the draft store holds a draft, an attachment or a pending or
in-flight send, including conversations no longer on screen; it used to check
only the open one. Tapping a notification while the app is open routes inside
the page, without a reload, so session-only computers and drafts survive; a page
from an older release that does not answer the service worker within three
seconds is navigated as before. The error screen's **Back to agents** also
routes inside the app, so it stays under `/pwa/` and keeps session-only
pairings. A space that is still loading, or has closed, keeps its header and
Back.

Returning to the foreground keeps any relay link that can show it is alive, so
an agent start, a prompt or a file transfer in flight is not dropped by a tab
or app switch; [relay.md](relay.md#recovering-from-network-changes) has the
rule. Signing out, revocation or a sealed `bye` retires the computer before its
link is closed, and a closed link stays closed, so a signed-out browser does
not redial the relay.

Updated clients and computers support 32 MiB relay uploads, split into bounded
64 KiB chunks with progress, cancellation and recovery from transient disconnects.
Per-chunk requests have a 60-second deadline; bandwidth limits stay unchanged,
so larger uploads can take several minutes. Older computers keep the 761 KiB
limit. A partially completed browser batch keeps completed attachments and offers
to retry remaining files. The hosted app has no built-in SSH tunnel.

Run `bun run test:pwa` after `bun run build:site` to check shell caching, offline
launch and interrupted updates. The [September customer-journey report](customer-journeys-2026-09-18.md)
separates real-server checks from fixture coverage and physical-device gaps.
Its local verification does not establish a production deployment.

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

## iOS beta requests

The landing-page form posts to `/api/ios-beta`, handled by `site/src/index.ts`.
Cloudflare Email Routing sends each request to the verified mailbox that receives
`support@getshahi.dev`; the public alias remains the message's To header and the
applicant is Reply-To. `BETA_DELIVERY_TO` is a Worker secret containing that
verified destination. Update it if the support forwarding rule changes.
The sender is `beta@getshahi.dev`. The domain must have Email Routing enabled.

Requests require a same-origin JSON submission, an email address, and consent.
A honeypot, a 2 KB body limit, and five requests per minute per IP per Cloudflare
location limit abuse. This is a lightweight limit, not global bot protection.
No signup database is maintained. Email acceptance is awaited before success;
inviting the applicant to TestFlight remains a manual action.

Run `bun test site/signup.test.ts` and `bunx tsc --noEmit -p site` for checks.
Use `bunx wrangler dev --config site/wrangler.toml` after building to test the
form locally; a plain static file server cannot handle submissions. Local email
bindings do not deliver unless explicitly configured for remote email testing.
