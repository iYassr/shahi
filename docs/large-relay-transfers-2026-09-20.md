# Larger tunnel files — feasibility review, 20 September 2026

## Implementation update

The working tree now implements a 32 MiB upload capability, 64 KiB chunks,
durable offset receipts, SHA-256 finalization, bounded retry, progress and
cancellation. The rate remains unchanged. The design below records the original
review; its proposed faster rates are not enabled. Release preparation is in progress; production rollout is not yet confirmed.

## Original recommendation

Target **32 MiB uploads through the encrypted relay**, matching SSH, using
resumable chunks. Keep the current 1 MiB encrypted-frame limit and bounded
queues. Do not raise the single-message file limit in isolation. This original
design recommendation is not a capacity certification. See the implementation
update above for the subsequent work.

## What limits transfers today

| Limit | Current value and consequence |
| --- | --- |
| Relay upload | 779,264 bytes (761 KiB), after reserving multipart overhead inside a 783,360-byte body |
| Encrypted message | 1 MiB; body encoding adds approximately one third before encryption |
| Upload throughput | 64 KiB/s of encrypted phone-to-box traffic, with a 1 MiB burst; client pacing targets 90% of this rate |
| Pending client bodies | 2 MiB total, at most 16 requests |
| Socket and unacknowledged output | Separate 2 MiB bounds |
| Per computer | Eight phone connections; four active requests per link, sixteen relay requests total |
| Sidecar file work | Two concurrent upload/file handlers; 32 HTTP handlers total |
| Upload timeout | 60 seconds in each client |
| SSH upload | 32 MiB |
| Download helper | Sequential 512 KiB ranges, capped at 25 MiB; collects the entire result in client memory |

Evidence: `shared/src/relay.ts`, `shared/src/relay-client.ts`,
`relay/src/box.ts`, `server/lib/relay-client.ts`, `server/lib/http.ts`,
`server/lib/uploads.ts`, `shared/src/file-download.ts`, and mobile/web upload
implementations. The upload byte-rate limiter is phone-to-box, not a symmetric
download throughput setting.

Cloudflare currently accepts received WebSocket messages up to 32 MiB, so our
761 KiB upload ceiling is an application choice. That platform maximum is not
a safe target frame size: the runtime has a 128 MB memory limit per isolate,
and multiple objects can share an isolate. Large JSON/base64 bodies also create
several temporary allocations on the phone and computer.
Sources: [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
and [memory accounting](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/).

## Proposed transfer design

1. Negotiate an additive upload capability through the existing app API. Older
   computers retain the current upload behavior. Keep relay protocol 2 framing;
   the relay forwards the same small encrypted requests without learning file
   names or contents.
2. Begin an authenticated upload with a bounded declared size. Bind its random
   transfer ID to the device/session and destination computer. Reserve disk
   quota before accepting data; store private partial files outside projects.
3. Read and send **256 KiB chunks**, initially one unacknowledged chunk per
   transfer. Write each chunk directly to the computer's temporary file. Neither
   relay nor client should assemble the full upload in memory.
4. Acknowledge committed offsets. Repeated chunks must be idempotent: identical
   bytes at the same offset return the same result, conflicting bytes fail.
   After a reconnect, ask for the accepted offset over the new authenticated
   connection. Never reuse old encrypted frames or replay chat writes.
5. Verify final length and a streaming whole-file digest, then atomically
   publish the attachment. Finalization must also be idempotent if its response
   is lost. Only completed files can be attached to an agent message.
6. Prioritize chat, heartbeats and acknowledgments before sealing frames. Pace
   bulk work fairly across devices on the same computer; retain queue and socket
   bounds. Already-sent bytes share a WebSocket, so smaller chunks reduce but do
   not eliminate delays on slow links. Measure that delay before release.
7. Keep one active upload per device and initially two per computer. Apply
   existing file-handler limits to every new chunk route: today's path check
   only recognizes `/api/uploads` and `/api/file`. Add aggregate partial-byte
   quotas, expiry, disk-full handling, cancellation and cleanup after restart.
8. Use per-chunk deadlines plus a progress/idle deadline for the whole transfer,
   with a bounded lifetime. Show progress, cancellation and reconnection state.
   Do not hold a single 60-second request open for the entire file. Mobile
   background suspension should pause/resume; do not promise iOS background
   execution. Lost source-file access should ask for reselection safely.

The client pacer's special-case upload detection currently matches exactly
`/api/uploads`. New routes need explicit bulk scheduling, not an unnoticed
bypass of the existing pacing protection. Admission and expiry must account for
all paired devices, not just currently open sockets.

## Speed and scale

At today's upload rate, a hypothetical chunked 32 MiB file would need roughly
**12 minutes of pacing time**. Chunking solves the size limit, but speed needs
a separately validated rate change. A candidate 512 KiB/s encrypted-byte rate
would reduce that arithmetic estimate to about **93 seconds**; 1 MiB/s to about
46 seconds. These estimates use base64 overhead, the current 90% pacing factor
and an initially full 1 MiB burst. They exclude latency, competing traffic,
encryption/disk time and sequential acknowledgment delays; they are not measured
transfer speeds or promises.

Hundreds of customers on different computers spread across separate Durable
Objects. Hundreds on one computer are a different requirement: Shahi currently
allows only eight phone links per computer. Cloudflare describes objects as
single-threaded, horizontally scalable, with a soft 1,000 requests/second limit
per object; this is not a bandwidth guarantee.
[Source](https://developers.cloudflare.com/durable-objects/platform/limits/).

At 500 simultaneous uploads each consuming 512 KiB/s, the aggregate is
**250 MiB/s per relay leg**, before transport overhead. Small chunks bound
per-transfer buffers but cannot eliminate aggregate bandwidth, message charges,
runtime overhead or slow-receiver queues. Per-box separation is not a promise
of a dedicated 128 MB allocation for every box.

The recorded local 1,000-phone test exchanged 2 KiB messages. It establishes
small-message coverage, not large-transfer capacity. See [operations](operations.md#concurrency-verification).
The actual account's Workers subscription and remaining usage need checking
before a paid load run. A Cloudflare Pro domain plan does not itself include
Workers Paid. [Cloudflare pricing](https://developers.cloudflare.com/workers/platform/pricing/).

## Evidence required before enabling the larger limit

- Compare chat latency against an idle-transfer baseline at 100, 300 and 500
  concurrent clients, spread across computers. Exercise both mixed traffic
  (for example, 50 uploads among 500 chatting clients) and all-client uploads.
  Separately saturate all eight links to one computer.
- Use isolated staging identities/services for deployed-relay tests, not user
  sessions. Test distributed sources plus shared-IP reconnect bursts; local
  workerd cannot validate the public edge limiter or geographical latency.
- Exercise 0-byte, chunk-boundary, 1/5/10/25/32 MiB and over-limit files. Verify
  final hashes, concurrent duplicate filenames and lost finalize responses.
- Interrupt before/after chunk acknowledgments, change Wi-Fi, suspend/resume
  mobile, restart the sidecar, revoke a device, fill disk and inject slow readers.
  Verify accurate resume, bounded temporary storage and no partial published file.
- Record process/runtime memory, CPU, queue depth, chat p95/p99 latency, transfer
  success, close codes, throughput and billable activity. Check for sustained
  memory growth and collateral disconnects during a soak and reconnect storm.
- Proposed release gates: zero corruption/unauthorized resume/duplicate finalized
  attachments, no unbounded buffers or disk growth, and no unrelated connection
  loss from bulk traffic. Set an explicit chat-latency budget against measured
  baselines before accepting a new rate; reduce bulk concurrency/rate if missed.

Start with 32 MiB only after these gates pass, using a reversible negotiated
capability. Larger limits such as 100 MiB can use the same design later, but need
fresh duration, storage and mobile-lifecycle validation. Downloads beyond the
current preview cap also need disk/stream-based sinks, rather than increasing
the existing in-memory assembly limit.


## Implemented validation

- Actual deployed Cloudflare relay to an isolated Ubuntu sidecar/herdr 0.9.1:
  0-byte, 1-byte and 32 MiB uploads completed. All three stored-file SHA-256
  checks matched. The largest transfer took 729 seconds (about 12 minutes).
- During that transfer, one accepted chunk acknowledgment was deliberately lost
  and the encrypted link reconnected. Retrying produced the correct final file.
  All 243 concurrent session checks succeeded; p95 was 456 ms. The test reached
  Cloudflare through an SSH-backed local WebSocket bridge, so these latency
  numbers describe that route, not mobile network performance.
- Local workerd: 500 computers/phones, 15,000 encrypted-sized opaque chunks,
  1,318,410,000 forwarded upload bytes, plus chat. All payload checks passed.
  Chat p95 was 719 ms under bulk load versus 397 ms in the baseline; p99 under
  load was 820 ms. This 59-second run is a forwarding stress check, not 500
  real full-file uploads, a long soak, or a production capacity guarantee.
- Chromium and WebKit: encrypted 1 MiB browser attachment and existing
  attachment/download regression passed (four cases).
- Native tests cover bounded file reads, offset receipts, progress and legacy
  server fallback. A physical iPhone upload has not been exercised in this run.
- Transfer tests cover 32 MiB boundaries, conflicting retries, restart recovery,
  uncommitted disk bytes, ownership, expiry, cancellation, lost chunk/final
  replies and refusal to overwrite a file whose receipt expired.
- The relay regression suite passed 68 checks. No relay byte-rate or frame-limit
  increase was made. Native production build 13 was built with the iOS 27 SDK;
  distribution status is recorded separately in the release checklist.

The original proposed multi-region and long-duration load gates remain future
capacity work. The current release keeps existing throughput/admission bounds
rather than claiming a validated faster global bandwidth allowance.
