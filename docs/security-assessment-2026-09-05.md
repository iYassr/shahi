# Relay and public service security assessment — 5 September 2026

> Historical assessment. The findings below describe code reviewed before the
> fixes in [`81297b4`](https://github.com/iYassr/shahi/commit/81297b4).
> Upgrade the sidecar and clients together. Older snapshots, including
> `91eda62`, do not contain these fixes. See [remediation](#remediation--5-september-2026)
> for scope and verification. This is a maintainer review, not an independent audit.

The encryption claim is supported by the reviewed implementation: a relay that
only controls transport cannot simply read or forge a session. That is a useful,
real property. It does not establish that the overall product is secure against
service disruption, a compromised browser distribution origin, or unsafe direct
HTTP configuration. Two availability defects were reproduced during this review.
No unauthenticated terminal-control or session-decryption bypass was found in
the paths examined.

This assessment covers the current working tree, based on commit `1ec39f5` with
existing uncommitted changes. It combines source review, isolated local
reproductions, existing security tests, and low-volume public HTTP checks. It is
not an independent cryptographic audit or an attestation that every deployed
component exactly matches the working tree. The findings below describe the
initial assessment before changes. The subsequent user-authorized remediation
and deployment are recorded at the end of this document.

## Confirmed findings

### 1. Medium: an unproven device hello can occupy every phone slot

An attacker needs the relay address, a server ID, and **one active device ID**.
They do not need its secret. These identifiers are not realistically guessable,
but the relay observes them in connection paths and plaintext hellos. A leaked
identifier is consequently enough for this availability attack, even though it
is insufficient to decrypt a session.

`server/lib/relay-client.ts:399–407` issues a valid device token and calls
`server.attach()` immediately after receiving a syntactically valid hello.
Receiving the hello has not proved possession of the device secret: only
successful opening of an authenticated encrypted frame would do that.

The relay marks the connection as having spoken on its first binary frame
(`relay/src/box.ts:188`), removing its 15-second hello deadline. The sidecar then
sends an encrypted dashboard and periodic heartbeats. Outgoing box traffic
updates the phone's idle timestamp (`relay/src/box.ts:219`), so the server's own
heartbeats keep the unproven connections alive.

**Reproduced using the actual local Worker, actual `RelayClient`, and actual
HTTP server, with a synthetic device, empty session and isolated databases:**

```text
8 attacker connections; 0 authenticated attacker frames sent
8 encrypted dashboards received
9th connection: 4429, "too many phones"
After 22 seconds (past the 15-second hello deadline):
8 attacker connections still open; 8 encrypted heartbeats received
9th connection retry: 4429, "too many phones"
```

The continued lifetime follows from the heartbeat/idle logic; the reproduction
waited 22 seconds, not the full session lifetime. New or reconnecting legitimate
clients are blocked. Already-connected legitimate clients are not evicted by
this attack alone. The attacker receives ciphertext, not readable dashboards.

**Fix:** require an authenticated client frame within a short deadline before
issuing the device session, attaching the stream, or starting dashboard work.
An unproven link must expire regardless of outgoing traffic. Test valid-looking
hellos that never prove a secret; the existing squatter test covers only peers
that send no hello at all.

### 2. Medium: a malformed relay control frame terminates the sidecar

`server/lib/relay-client.ts:214–221` catches invalid JSON but does not validate
the parsed value before reading `msg.t`. A relay sending the valid JSON text
`null` triggers an uncaught exception in the WebSocket callback.

**Reproduced:** a separate Bun child process connected the real `RelayClient`
to a local synthetic relay that sent `null`. The child exited with code 1:

```text
TypeError: null is not an object (evaluating 'msg.t')
at #control (server/lib/relay-client.ts:221:13)
```

This requires control of the selected relay, or a relay bug that emits that
message. An ordinary phone cannot directly send this control frame through the
honest Worker. The distinction matters: a hostile relay can already deny relay
connectivity, but this defect also kills the local HTTP sidecar, interrupting
its other access paths until supervision restarts it. No code execution was
demonstrated.

**Fix:** validate the control envelope and each message's fields before acting.
Reject malformed controls through a controlled disconnect. Review the other
socket callbacks for valid JSON values such as `null` and arrays; catching JSON
syntax errors is insufficient.

### 3. Medium, direct-session limitation: passcode logout does not revoke access

`server/lib/http.ts:534–544` revokes paired devices on logout, but a passcode
session only receives an expired browser cookie. A copied signed cookie remains
usable until its expiry or signing-key rotation, normally up to 30 days.

This is explicitly reproduced by the existing test
`server/lib/http.pentest.test.ts:135`: logging out and then sending the old
passcode cookie still returns HTTP 200. That test passed during this review.
A passing test here confirms the undesirable behavior; it does not fix it.

**Fix:** give passcode sessions a server-side revocation mechanism and close
their corresponding streams on logout. Paired-device logout/revocation already
has a substantially better boundary.

## Deployment and trust limitations

### The browser distribution origin is trusted with full control

The hosted browser must execute JavaScript served by `getshahi.dev`. That code
handles pairing secrets, plaintext requests and decrypted responses. When the
user explicitly chooses persistence, `web/src/connection.ts:25–27` stores the
device identity and secret in IndexedDB.

A malicious application release, compromised publishing account, or executable
same-origin injection could use those capabilities. CSP helps prevent many
injection paths, but permits the legitimate application scripts and cannot
protect the user from a malicious replacement of those scripts. Path `/pwa/`
is not a separate origin from the marketing site.

Therefore, "the relay cannot decrypt frames" is supportable under the endpoint
trust assumption. "The service operator or hosting provider can never access
my session" is too broad for the hosted browser. The browser-hosting document
already acknowledges this limitation. Native clients avoid fetching fresh
website JavaScript on each visit, while still trusting their own build and
update supply chain.

### The old relay hostname remains a public entry point

`relay/wrangler.toml:16` enables `workers_dev = true`. Browser HTTP checks
confirmed that `shahi-relay.yasserd99.workers.dev` still responds with the relay's
`not found` response, alongside `relay.getshahi.dev`.

Rules scoped only to the custom hostname/zone do not establish protection of
this alternate hostname. The in-Worker connection limiter still applies when
bound, so this is **not** a claim that the alternate hostname has no controls.
Cloudflare account settings, Worker-wide Access controls and actual WAF rules
were not inspected. No production flood or rate-limit bypass test was run.

The configured application limiter is per source IP, 30 attempts per 10
seconds. It is not a fleet-wide resource or spending ceiling. Cloudflare
documents the binding as local to each edge location and eventually consistent.
See [Cloudflare's rate-limit locality and accuracy documentation](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

**Action:** retire unused public aliases and preview routes, or explicitly
cover every supported route with equivalent controls. Verify abuse budgets,
limits and alerting in the actual account. A paid plan alone is not a security
control against distributed resource consumption.

### Direct HTTP remains unsafe to expose casually

An empty `PASSCODE_HASH_B64` disables authentication
(`server/lib/auth.ts:42–44,83–85`). Non-loopback binds are allowed with a warning
(`server/index.ts:141–170`). Combining those settings exposes full terminal
control to anyone who can reach the listener. This is a **high-impact
configuration hazard**, not an observed bypass of the current installation:
the plugin generates a passcode, and the checked listener required one.

Direct-session cookies omit `Secure` (`server/lib/auth.ts:106–115`). The comment
about TLS termination at a reverse proxy does not justify that omission for
an HTTPS-facing browser: `Secure` governs the browser-to-public-origin hop.
The sidecar's local HTML also has no CSP in `harden()`; the hosted site's CSP
does not apply to that separate local origin.

**Action:** fail closed on missing authentication for normal operation, require
an explicit narrowly scoped development mode, keep the listener on loopback,
and support Secure cookies and a tested CSP wherever direct browser access is
offered. Relay encryption remains a separate gate; an empty HTTP passcode does
not by itself reveal the relay's device secrets.

### Privacy is not the same as anonymity or zero collection

The relay sees IP addresses, stable server/device identifiers, times and frame
sizes. `relay/src/telemetry.ts` records connection events keyed by server ID;
`relay/wrangler.toml` binds the Analytics Engine dataset. A hash used as a
stable identifier remains correlatable metadata.

Native push goes through Expo and the platform push service separately from
the relay encryption. Notification payloads include workspace/terminal labels.
The privacy policy now discloses these boundaries. The narrow statement
"terminal traffic is encrypted from the relay" should not be expanded into
"no provider receives any information about my sessions."

## Controls that checked out

- X25519 ephemeral exchange, a 32-byte shared secret mixed into HKDF, separate
  ChaCha20-Poly1305 direction keys, authenticated decryption, and exact next
  counter checks are present in `shared/src/e2e.ts`.
- The reviewed callers use platform cryptographic randomness. Wrong secrets,
  ciphertext tampering, reflections, replay, skipped frames, and reused frames
  across fresh connections were rejected in the focused tests.
- The Worker authenticates box ownership with a signed fresh challenge and a
  public-key-to-server-ID check before replacing an existing box.
- Pairing uses random 256-bit, single-use, ten-minute codes. Device secrets are
  delivered inside the encrypted pairing exchange. Paired-device revocation
  is checked on requests and actively closes corresponding streams.
- Browser-origin checks guard API writes and direct WebSocket upgrades;
  transcript Markdown renders as React text/elements, not injected raw HTML.
- Public browser checks confirmed CSP, HSTS, `nosniff`, denied framing and
  `no-referrer` on `/pwa/`, with a `/pwa/` service-worker scope and `no-store`
  on `/pwa/sw.js`. `/pwa/settings` also received the expected CSP.
- Public website `/api/meta` and `/.env` returned 404. Public relay `/stats`
  returned 404 without credentials. These results establish the checked
  responses, not a guarantee about every possible path.
- The local listener was `127.0.0.1:7171`. Without credentials,
  `/api/auth/status` reported authentication required and `/api/session`
  returned 401. No real terminal writes were performed.

## Validation and limits

The focused run passed **144 tests across 11 files**, covering encryption,
relay routing/quotas, box authentication, pairing, revocation, HTTP penetration
cases and browser cache boundaries. **Four dependency patch checks also passed.**

`bun audit` still reports three advisories for `decode-uri-component@0.2.2`
and `image-size@1.2.1`. The repository applies local security patches to those
versions, and the installed-package regression checks passed. Reporting these
as three confirmed exploitable vulnerabilities would ignore that evidence;
calling the raw audit clean would also be inaccurate.

Two additional isolated reproduction scripts were written under
`/tmp/shahi-security-review-2026-09-05/`: `slot-proof.ts` and
`malformed-control-proof.ts`. They use synthetic identities and local sockets.
The slot reproduction stopped its own Worker and sidecar and removed its
temporary databases. The crash reproduction used a separate child process.

Public HTTP checks initially received Cloudflare 403 responses through Python;
normal browser checks succeeded and provided the deployment observations above.
The browser profile already had a remembered pairing; seeing its dashboard
was not evidence of anonymous access. Credential values were not inspected.

Not established: Cloudflare account IAM/MFA and token permissions, deployed
Worker source equivalence, all DNS aliases or external port forwarding,
production load resistance, independent protocol review, or the integrity of
the native release/update supply chain. The source findings and public header
observations should be kept distinct from those unverified properties.

## Remediation — 5 September 2026

Source fixes are published in commit `81297b4`:

- Require a valid encrypted client frame within fifteen seconds before granting
  a device session or attaching a stream. Recheck revocation at proof time.
  Updated clients send proof immediately after key derivation.
- Bound and validate relay controls. Invalid controls reconnect safely; malformed
  encrypted JSON ends its link without terminating the sidecar.
- Give sessions independent nonces and persist logout revocations. Legacy HTTP
  cookies require a new login; paired-device secrets remain valid.
- Reject missing passcodes, non-loopback listeners, and insecure remote relay
  URLs at startup. Apply CSP to direct HTML and Secure cookies to HTTPS access.
- Disable alternate Worker hostnames and preview URLs in deployment configuration.

The earlier remediation run recorded deployment and local service checks.
Those observations are historical, not a guarantee that any particular
installation has upgraded. A source push does not deliver a new native binary.
Per-IP limits reduce bursts but do not prevent distributed denial of service
or impose a hard spending cap.

Before this publication, the working tree passed 565 unit tests, four dependency
patch checks, 57 relay tests, and 221 native tests, with all TypeScript checks
passing. Twenty-six opt-in live unit checks were skipped. The relay regression
fills all eight slots with unproved hellos, confirms no dashboard is sent,
waits for expiry, and then authenticates a synthetic device. Native fixtures
verify the client's first proof frame. No real terminal commands were sent.

Independent cryptographic review, account IAM/MFA, production load resistance,
and physical-device release delivery remain outside this verification.
