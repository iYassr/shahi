# Connecting a phone to a Shahi server

How a phone reaches the sidecar. This is the onboarding **decision record**: it
is written in the present tense of the day it was decided, and kept that way on
purpose — the reasoning is the point. `README.md` says what ships.

> **What actually shipped, and what changed since.** The outbound relay was
> built rather than adopted: a Cloudflare Worker of our own (`relay/`), not
> `cloudflared`, and the envelope is X25519 → HKDF → ChaCha20-Poly1305, not the
> P-256/AES-GCM sketched below. Option 3, Tailscale, was removed entirely on
> 2026-09-04: it was never a transport of its own — the SSH tunnel rides on the
> very HTTP path it used — and keeping it meant a second pairing route, a bind
> that wanted exposing, and a blanket ATS exception to defend. Two ways in
> remain: the relay, and SSH.

## The problem with Tailscale-only

At the time of this decision the only front doors were **Tailscale** (the phone
and the box share a tailnet) and **SSH** (the app opens its own tunnel). Both work and both are
private, but both assume the user has already solved reachability — a tailnet set
up on two devices, or an SSH login they can reach. That is a real adoption
ceiling: the person who would most benefit from answering an agent from their
phone is the least likely to have already stood up Tailscale.

The bar to clear: reach the box **from any phone, on any network, with no
port-forward, no firewall change, and no VPN to install** — while keeping the one
property a shell-execution tool cannot give up.

## The one property we cannot give up

`pane.send_text` is arbitrary shell execution as the user. So **anything in the
network path that can read or inject into that channel is a remote-code-execution
surface.** Today the boundary is "tailnet reach + passcode." The moment we leave
the tailnet, two things must both hold:

1. The transport is **authenticated** (the passcode already does this).
2. **Any relay in the path is blind** — it brokers ciphertext it cannot read.

Property 2 is why we cannot simply expose the HTTP server through a public tunnel
and call it done. Cloudflare Tunnel, ngrok, and Tailscale Funnel all **terminate
TLS at the vendor's edge** — they would see the plaintext shell stream. For most
apps that is a shrug; for this one it hands a third party a shell. So E2E
encryption is not a nice-to-have here. It is the thing that makes a third-party
pipe tolerable at all.

## The decision: Cloudflare Tunnel + end-to-end crypto + QR pairing

Three ways in, in priority order. The first becomes the default.

### 1. Cloudflare Tunnel + QR pairing — the new default

- **Reachability: Cloudflare Tunnel (`cloudflared`).** The box dials *outbound* to
  Cloudflare and gets an HTTPS/WSS endpoint. No inbound port, no firewall change,
  works behind CGNAT. This is the generic reach Tailscale was gating.
- **Privacy: end-to-end encryption on top of the tunnel.** Cloudflare is a dumb
  pipe. Every WebSocket message and request/response body is encrypted with a key
  only the phone and the server hold, so the edge only ever sees ciphertext. This
  is exactly the shape [`0cv/herdr-mobile-relay`](https://github.com/0cv/herdr-mobile-relay)
  ships (P-256 ECDH → HKDF-SHA-256 → per-message AES-256-GCM) and
  [Happy](https://github.com/slopus/happy) ships (TweetNaCl, "the relay stores
  opaque encrypted blobs"). The passcode stays the app-layer auth on top.
- **Onboarding: one QR scan.** The install script sets up the tunnel and prints a
  QR carrying the endpoint URL and the pairing secret (in the URL fragment, never
  on the wire). The phone scans it and derives the E2E key. No account to make on
  the phone, no address to type.

Net onboarding: **run one script, scan one code, you are in — from anywhere.**

The honest cost: the E2E layer is **load-bearing, not decorative.** Get the key
derivation or nonce handling wrong and a "blind" pipe becomes a plaintext pipe in
front of a shell. This part gets a real crypto review, not a vibe check.

Where that stands (2026-09-02): the relay became the herdr plugin's default
way in (plugin 0.2.0) on two internal reviews — `docs/security-review.md`,
E1–E3 and R1–R8, whose findings are fixed — and before an outside one. The
reasons: the construction is small and standard (X25519, HKDF-SHA-256,
ChaCha20-Poly1305, a counter nonce, strict ordering), the relay reads
nothing, every install can turn it off with one line, and a first install
that could not be reached from a phone at all was the larger risk to the
product. What would revoke the default: an outside finding that the envelope
leaks, which would be fixed before any relay carried a frame again.

### 2. SSH — kept for power users

Already built (the native tunnel forwards to loopback, host key pinned on first
use). Works anywhere SSH does, nothing extra to install, no third party in the
path. Not the default only because it assumes an SSH login the user can reach.

### 3. Tailscale — kept as the maximum-privacy option *(since removed)*

Decided here as: demoted from *requirement* to *option*, on the grounds that
WireGuard is end-to-end and it cost nothing to keep.

It turned out to cost something. It was not a transport but a typed address
pointed at an exposed bind, and SSH already reached the same sidecar over the
same HTTP client with nothing exposed and no VPN — so it served the "zero third
parties" case at least as well. Removed 2026-09-04; a phone now reaches a box
through the relay or over SSH.

### Not a default: bring-your-own public tunnel

A plain Cloudflare Tunnel or Tailscale Funnel **without** the E2E layer, or ngrok,
can be documented for people who insist — but with the tradeoff stated plainly:
they terminate TLS at a vendor edge, so the passcode becomes the *only* wall in
front of a shell. Never the onboarding default.

## What the field does

Every tool that reaches a box from anywhere with no user network setup uses an
**outbound-dialing relay** (the box dials out; no inbound ports). They split on
whether that relay is blind.

| Tool | Reach | Relay sees plaintext? | Pairing |
|---|---|---|---|
| **Happy** (slopus) | outbound WS relay, self-hostable | **No — E2E, blind relay** | QR |
| **0cv/herdr-mobile-relay** | Cloudflare Tunnel | **No — E2E on top** | QR |
| **Anthropic Remote Control** | outbound to Anthropic API | Yes (TLS-to-vendor) | toggle `/rc` |
| **Omnara** | hosted relay, self-hostable | Yes (HTTPS, not E2E) | account |
| **Moshi** | SSH / Mosh, BYO network | n/a (SSH E2E) | QR "Easy Pair" |
| **Termius / Blink** | SSH / Mosh, BYO network | n/a (SSH E2E) | manual |
| **VibeTunnel** | BYO (Tailscale/ngrok/CF) | depends on choice | — |
| **Shahi (when this was written)** | Tailscale / SSH | No (both E2E) | tailnet URL |
| **Shahi (now)** | blind relay / SSH | **No — E2E on top** | QR |

The tools that reach *and* stay private (Happy, 0cv) are the ones with a **blind
E2E relay**. That is the target.

## Connectivity options, at a glance

As surveyed at the time. The two that ship are marked; Tailscale was later
removed (see the note at the top).

| Option | Inbound port? | Account? | Relay sees plaintext? | Friction |
|---|---|---|---|---|
| **Blind relay + E2E** — *ships, default* | **none** | none | **no (E2E on top)** | **none** |
| **SSH tunnel** — *ships* | none (an SSH login) | no (keys) | no (E2E) | low if reachable |
| Tailscale — *removed 2026-09-04* | none | yes | no (E2E) | medium (client both ends) |
| Cloudflare / ngrok, no E2E | none | yes | **yes** | low — but unsafe here |
| Tailscale Funnel | none | yes | **yes** | low — but public + plaintext |

## Build order

Each phase leaves a working product; nothing trades a shipped feature for an
unfinished one.

1. **The E2E envelope, on the existing transport.** Add app-layer encryption to
   the HTTP/WebSocket messages the app already exchanges, keyed off a
   pairing secret. Prove it over the *current* Tailscale/SSH transport first, so
   the crypto is validated before any new pipe exists.
2. **QR pairing.** The install script mints a pairing secret and prints a QR
   (endpoint + secret in the fragment); the app scans and derives the key.
3. **The outbound tunnel.** The install script sets up `cloudflared` (or an
   equivalent outbound tunnel) and puts its URL in the QR. Now the box is
   reachable from anywhere, and step 1 guarantees the tunnel only carries
   ciphertext.
4. **Make it the default onboarding** in the app and the installer, with SSH and
   Tailscale demoted to explicit alternatives. Done in the plugin (0.2.0).

Step 1 is the one that matters most and the one most easily gotten wrong — it
was done first, in isolation, reviewed twice internally, and still wants an
outside pair of eyes; the paragraph under "The honest cost" says why the
default did not wait for that.
