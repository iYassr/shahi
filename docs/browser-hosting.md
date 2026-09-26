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

Publish only from a clean checkout of a committed revision, and record the
Cloudflare version ID beside that commit, as the verified-deployment section
below does. The privacy policy the App Store listing links to was once
deployed from uncommitted work, so for days the text users read existed in no
commit at all. Every publish gets an entry of its own, with the version it
replaced, which is the one to roll back to; `bunx wrangler deployments list`
in `site/` shows both. The homepage publish of 25 September went unrecorded,
so this file named a version that was no longer serving as the current one
(pre-release bug hunt, B102).

`bun run build:web` still builds the local sidecar client in `web/dist` with `/`
as its base. Hosted output is independently built in `web/dist-hosted` with
`/pwa/` as its base. Both generated directories are ignored by Git.

The static host explicitly rewrites browser routes to the `/pwa/` application shell; it
returns 404 for unknown paths, including `/api/*`. Those 404s carry the site's
"Page not found" page (`site/public/404.html`, with its own CSP in a meta tag)
rather than an empty body; still a 404, never a fake success. That includes
`/404` and `/404.html`, which the Worker answers itself: the assets served the
page at `/404` with a 200, as they serve any page at its name (pre-release bug
hunt, B98). An exact app route typed with a trailing slash, such as
`/pwa/settings/`, is redirected to the route without one; it was a 404. It must
never supply a successful HTML response to an API request. The site is not an
HTTP API proxy.

Caching, from `site/public/_headers`: every unhashed file under `/pwa/`,
including each app route rewritten to the shell, is `no-cache`, so a browser
revalidates it; `/pwa/assets/*` is
`public, max-age=31536000, immutable`; `/pwa/sw.js` is
`no-store`. The rule once named `/pwa/` alone, and since header rules match
the requested path rather than the rewrite behind it, `/pwa/pane/*` and every
other app route were served the same HTML with nothing telling a cache to
revalidate it.

HTML, the 404 page included, is `public, no-transform`, which keeps Cloudflare
from injecting its analytics beacon ([operations](operations.md)). That same
directive turns off Cloudflare's compression, and until 2026-09-25 every file
had it, so production sent all text uncompressed, the app's 548 KB bundle
included. `/pwa/assets/*` and the site's own CSS, JavaScript and SVG files, each
named by its exact path in `_headers`, now go without it and are compressed at
the edge. `bun run test:pwa` fails for a CSS, JavaScript or SVG file in
`site/dist` that `_headers` does not name. One HTML response goes without
`no-transform`: the 404 page for a missing file under `/pwa/assets/`, which
takes that path's rule. There its policies are what refuse an injected beacon:
`/pwa/*`'s `script-src 'self'`, which `test:pwa` checks on that response, and
the 404 page's own `default-src 'none'`. `wrangler dev` compresses regardless, so check a
release with a browser's headers:

```sh
curl -s -D - -o /dev/null -A 'Mozilla/5.0 (Macintosh) Chrome/140' -H 'Accept-Encoding: br, gzip' https://getshahi.dev/site.css | grep -i -e content-encoding -e cache-control
curl -s -D - -o /dev/null -A 'Mozilla/5.0 (Macintosh) Chrome/140' https://getshahi.dev/ | grep -i cache-control   # still no-transform
```

## Media

The homepage's launch video, its poster and captions are served at
`/media/<name>` by the site Worker (`site/src/media.ts`) from the R2 bucket
`shahi-site-media`, bound as `MEDIA`. Not static assets: they answer a `Range`
request with the whole file as a 200 and no `Accept-Ranges` (measured
2026-09-25 in wrangler 4.129 and on getshahi.dev), and Chrome then cannot seek.
Not git: the repository is what every `herdr plugin install` clones, and the
video would double it. Not a Cloudflare Stream embed: its player is a
third-party script, and this origin runs none. `_headers` does not apply to a
Worker's response, so `media.ts` sets every header itself.

Each name carries the first eight hex digits of its file's SHA-256, so a hit
is cached as `immutable` for a year and a new cut is a new URL.
`site/media.json` lists the published files, and `bun run test` holds the
homepage to it. To publish a new cut:

```sh
cd marketing/video && bun run render:launch && cd ../..   # the masters and the captions
bun marketing/video/scripts/publish-media.ts --remote
```

The script encodes the masters for the web (H.264 and stereo AAC, index
first), renders the poster, names each file after its content, rewrites
`site/media.json` and the page's four `/media/` URLs, and uploads the files.
Then commit those two files and build and deploy as above: upload first, so the
page never names a file the bucket lacks. Rerunning it on an unchanged cut
gives the same names. `--local` fills the local R2 that
`bunx wrangler dev --config site/wrangler.toml` reads (`site/.wrangler/state`)
instead. The bucket is created once, before the first deploy that binds it,
with `bunx wrangler r2 bucket create shahi-site-media`. Delete a previous cut's
objects a day after the deploy that replaced it, not before: a page opened
earlier still names them.

After deploying, `curl -s -D - -o /dev/null -H 'Range: bytes=0-1'
https://getshahi.dev/media/<file>` must answer 206 with
`Content-Range: bytes 0-1/<size>`. Use GET, as that does: `curl -I` sends
HEAD, which the Worker answers without a range, as HTTP defines ranges for GET
alone. `bun run test:pwa` checks the same in both
engines against small stand-ins that `e2e/hosted/seed-media.ts` stores under
the manifest's names in a local R2 of its own, so it needs no rendered video.

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

## Verified deployment — 26 September 2026, the bug-hunt fixes

Published the site and hosted client from a clean checkout of `6737727` (the
126 fixes from the pre-release bug hunt, plus the launch-video test split) as
Cloudflare version `504b885f-122c-4c51-9241-000b639ceb2c`. It replaced
`64c4d420-4c5f-4b76-a411-09760780e031` (below), which is the version to roll
back to. Checks after deploying:

- The live `/` is byte-identical to the build.
- `/`, `/privacy`, `/pwa/`, `/pwa/sw.js` and `/og.png` answer 200.
- `/404`, `/404.html` and an unknown path answer 404.
- `/pwa/settings/`, `/pwa/computers/` and `/pwa/spaces/` answer 301 to the
  same route without the slash, and `/pwa/notification/` keeps its query.
- The wide cut answers `Range: bytes=0-1` with 206.
- `GET /api/ios-beta` answers 405, with `nosniff` and HSTS.

`http://getshahi.dev/` still answers 200 over cleartext. That is the zone's
"Always Use HTTPS" setting (B51), which only the owner can change.

The relay was deployed from the same checkout as `shahi-relay` version
`d56e3bd0-db54-4e41-84a1-44d246d1878f`. It replaced
`cd7d78ae-0b5d-4a50-83f6-ef5037c67645`, the version to roll back to. Checks
after deploying:

- `GET /health` and `HEAD /health` answer 200, and `DELETE` answers 405 with
  `Allow: GET, HEAD`.
- `http://relay.getshahi.dev/health` answers 301 to HTTPS from the Worker
  itself.
- The owner's 0.3.7 computer reported `relay.connected: true` within a minute.

For about half a minute after `wrangler deploy` returned, some edges still
served the previous version: HEAD answered 404 and cleartext answered 200.
Check again before concluding a deploy failed.

## Verified deployment — 25 September 2026, the launch video

Published the site from a clean checkout of `c17d65e` (the launch video on the
homepage, served from R2, and the landing-page audit's fixes) as Cloudflare
version `64c4d420-4c5f-4b76-a411-09760780e031`. The bucket `shahi-site-media`
was created first, and the four files named in `site/media.json` were uploaded
after checking each against its sha256. Checked after deploying: `/`,
`/privacy`, `/pwa/` and `/og.png` answer 200; `/`'s policy carries
`media-src 'self'`; the wide cut answers `Range: bytes=0-1` with 206 and
`Content-Range: bytes 0-1/4395677`, a plain GET with 200 and the immutable
Cache-Control, a range past the end with 416, and an unknown name with 404;
`/site.css` now arrives with `content-encoding: br` while `/` keeps
`no-transform`. In Chromium (1440 wide) and WebKit (iPhone 14) the page chose
the wide and the square cut, played, seeked to 0:20 and loaded all 14 caption
cues, with no policy refusals and no request to another origin. It replaced
`33c11069-ae4b-468e-a14e-6dbd68eff044` (below), the version to roll back to.

## Deployment — 25 September 2026, the homepage's two download choices

Published at 23:16 UTC on 24 September from `0dd970a` (the web app and a
TestFlight invite side by side) as Cloudflare version
`33c11069-ae4b-468e-a14e-6dbd68eff044`, fifty minutes after the entry below,
which it replaced; `fa88e525-771d-4d0a-a633-13ab292b9587` is its rollback. It
was not recorded when it was published, so what was checked afterwards is not
known. Recorded from `wrangler deployments list` after the pre-release bug hunt
(B102) found it serving and this file naming `fa88e525` as current. The hunt
found the live files byte-identical to `0dd970a`; the browser app under `/pwa/`
had not changed since `a586b7e`.

## Verified deployment — 25 September 2026

Published the site and hosted client from a clean checkout of `a586b7e` (the
pre-release review's fixes, after the history rewrite) as Cloudflare version
`fa88e525-771d-4d0a-a633-13ab292b9587`. Checked after deploying: `/`,
`/privacy` (dated 23 September), `/pwa/` and `/pwa/sw.js` answer 200, an
unknown `/api` path answers the 404 page, and the home page asks Google Fonts
for nothing. The relay was deployed from the same checkout as
`shahi-relay` version `cd7d78ae-0b5d-4a50-83f6-ef5037c67645`; its health check
answered 200 and a 0.3.6 computer reconnected to it. The previous relay
version, for rollback, is `f94f9ea3-441b-4117-8386-f023ecf6c2d0`.

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

`_headers` does not reach a Worker's response, so `site/src/signup.ts` sets the
site's baseline headers on every answer itself (`X-Frame-Options`,
`Referrer-Policy`, `Cross-Origin-Resource-Policy`, `nosniff`, `no-store`, and
HSTS over HTTPS), and a 405 names `Allow: POST`; until the pre-release bug hunt
(B99) it sent `no-store` and `nosniff` alone.

Requests require a same-origin JSON submission, an email address, and consent.
A honeypot, a 2 KB body limit and the `BETA_LIMIT` binding limit abuse. The
binding is configured for five requests a minute per IP address (per /64 for
IPv6), but that is a nominal figure, not an exact count: Cloudflare keeps the
counter on the machine that runs the Worker, per location, and reconciles it
in the background ([its locality and accuracy
notes](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)).
Measured in the pre-release bug hunt (B100): 17 of 30 requests from one address
within a minute got through, most over fresh connections, which can land on
other machines; `wrangler dev`, whose counter is exact, refuses the sixth. It bounds a
sustained flood of signup mail to the support inbox, not a burst, and it is
not bot protection. No signup database is maintained. Email acceptance is
awaited before success; inviting the applicant to TestFlight remains a manual
action.

Run `bun test site/signup.test.ts` and `bunx tsc --noEmit -p site` for checks.
Use `bunx wrangler dev --config site/wrangler.toml` after building to test the
form locally; a plain static file server cannot handle submissions. Local email
bindings do not deliver unless explicitly configured for remote email testing.

Pairing links also work in an already open tab: `hashchange` opens the
confirmation card and removes the fragment from browser history. A failed claim
keeps its code; only success spends it. The card displays the normalized ASCII
relay origin that will actually be dialled.
