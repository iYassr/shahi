# File-transfer verification — 18 September 2026

Tested current code against a separate sidecar on the actual Ubuntu server, using a fresh herdr configuration and named session. Uploads went only to a dedicated temporary directory. No user conversations received test messages.

## Connections and sizes

| Path | Tests | Result |
| --- | --- | --- |
| SSH tunnel | 0 bytes, 1 byte, 1 KiB, 64 KiB, 512 KiB, 1/5/10/20 MiB, 32 MiB minus one byte, exactly 32 MiB | All accepted; sizes and SHA-256 hashes match the originals |
| SSH tunnel | 32 MiB plus one byte, 40 MiB plus one byte, 64 MiB | All rejected with HTTP 413 |
| Actual Cloudflare encrypted relay | 0 bytes, 1 byte, 1 KiB, 64 KiB, 512 KiB, 779,264 bytes | All accepted; sizes and SHA-256 hashes match |
| Relay transport | Bodies beyond its frame capacity, including 1/5/32 MiB files | Rejected locally; subsequent requests still work |
| Relay concurrency | Three 64 KiB files with the same filename | All accepted with distinct paths and matching hashes |
| Browser through relay | Empty file and exactly 779,264 bytes | Attachments appear in the composer |
| Browser through relay | 779,265 bytes, 1 MiB, 32 MiB | Size error shown; no attachment added |
| Slow browser through SSH | Exactly 32 MiB at a throttled 1 MiB/s | Completed in 32.3 seconds; attachment appears and server hash matches |
| Interrupted SSH transfer | Disconnect after sending part of a 5 MiB multipart request | No stored partial file; next upload succeeds |

The relay file limit is **779,264 bytes (761 KiB)**. Its request-body allowance is 783,360 bytes, with 4 KiB reserved by both clients for multipart framing. SSH supports **33,554,432 bytes (32 MiB)**. This run does not add chunked uploads or increase either limit.

There were 27 transport matrix cases: 20 accepted uploads and seven expected rejections. All 20 accepted files were independently checked on the Ubuntu filesystem. Browser and interruption checks were additional. These are representative sizes and exact boundaries, not every possible byte length.

The Mac reaches the actual relay through the existing SSH-backed WebSocket bridge; the encrypted payload still crosses Cloudflare. SSH upload tests use a separate loopback port forward. Browser checks use Chrome. The native file chooser and a physical iPhone were not exercised in this run, although mobile and web share the repaired relay transport.

## Bugs found and fixed

- Bun 1.3.13 can produce an empty multipart `File` without a name. Upload storage crashed while sanitizing that name. It now uses a safe fallback and stores the empty file successfully.
- Consecutive individually valid relay uploads could exhaust the relay's burst allowance and disconnect the client. The shared transport now waits for capacity before sealing/sending requests, accounts for upload transit time conservatively, and discards expired queued writes. No uncertain upload is automatically replayed.
- Web uploads used the ordinary 15-second request deadline, shorter than native's 60 seconds. Uploads now have the same 60-second deadline on both clients.

## Regression checks

- 667 shared/server/web/plugin tests passed; 26 opt-in tests skipped.
- 313 mobile tests passed across 38 suites.
- Type checking and web/hosted builds passed.
- Added regressions for empty unnamed files and paced uploads, including expired queued writes and encryption-counter ordering.

Changes are local and were verified on the isolated test service; production and TestFlight have not been updated by this run.

## Cleanup

All five temporary device grants were revoked. The isolated sidecar and herdr session were stopped, test uploads and state removed, and the temporary upload tunnel/browser proxy closed. The pre-existing relay bridge used by the simulator was left running.
