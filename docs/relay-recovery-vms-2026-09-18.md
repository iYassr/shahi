# OrbStack relay recovery verification — 18 September 2026

Release gate for the computer-side relay recovery changes. These results apply
to the tested working-tree snapshot, not an already published plugin release.
No production herdr session, pairing credentials, or user conversations were used.

## Environments

| OrbStack VM | Architecture | Recovery regression suite | Live relay recovery | Plugin service crash recovery |
| --- | --- | --- | --- | --- |
| Ubuntu 26.04.1 LTS | x86_64 | 56 passed | Passed | Passed |
| Debian 12 | arm64 | 56 passed | Passed | Passed |
| Fedora 44 | arm64 | 56 passed | Passed | Passed |
| Arch Linux ARM | arm64 | 56 passed | Passed | Passed |
| Alpine 3.23.5 | arm64 | 56 passed | Passed | Not supported: no systemd |

All VMs used Bun 1.4.1 with separate source copies and Linux dependencies.
The regression suite exercises actual WebSockets and a suspended child process,
as well as deterministic stuck-socket, retry, late-callback and request-replay
checks. This is 280 passing test executions across the five VMs.

## Deployed relay checks

`server/scripts/verify-relay-recovery.ts` creates a disposable server identity
and paired test device. The production relay client and shared phone client
exchange authenticated, encrypted synthetic GET responses through the deployed
Cloudflare relay. A loopback fault proxy forwards the original protocol frames;
it neither substitutes for the real relay nor weakens TLS or encryption.
Only this test's connections are interrupted.

The sequence checks:

1. An initial encrypted request.
2. A 20-second OS-level process suspension and subsequent tunnel reconnection.
3. Three repeated network interruptions.
4. Silent packet loss for 66 seconds without delivering a socket close event.
5. A 35-second outage that exercises the increasing retry delay.
6. Successful requests after recovery with the same paired identity.

All six steps passed on all five VMs. Each disposable identity established seven
authenticated tunnel connections and remained usable without re-pairing.

The probe uses the production heartbeat, silence and retry timings. It never
starts herdr or dispatches a command to a real agent.

`server/scripts/verify-plugin-supervision.ts` renders the plugin's actual systemd
unit template as a uniquely named, disposable user service. It kills the running
service, waits for systemd to restart it, and verifies an encrypted request over
the real relay using the original pairing. This passed on all four systemd VMs.
Temporary units, private test credentials, connections and child processes are
removed when each probe finishes.

## Reproduce

From a separate checkout inside a Linux VM:

```sh
bun install --frozen-lockfile --ignore-scripts
bun test server/lib/relay-recovery.test.ts server/lib/relay-resume.test.ts \
  server/lib/relay-client.test.ts plugin/service.test.ts shared/src/relay-client.test.ts
SHAHI_LIVE_RELAY_RECOVERY=1 bun server/scripts/verify-relay-recovery.ts
# systemd user-session VMs only:
SHAHI_LIVE_RELAY_RECOVERY=1 bun server/scripts/verify-plugin-supervision.ts
```

The live probes require outbound access to `relay.getshahi.dev`. They generate
their own credentials; do not supply a production identity. `SHAHI_TEST_RELAY`
can select a separately deployed test relay.

## Limits

Process suspension verifies paused timers, buffered traffic and fresh tunnel
creation inside each guest. It does not simulate every host sleep state, a
Wi-Fi driver's behavior, captive-portal sign-in, or a full VM power cycle. Packet
loss and disconnections are injected only into disposable test connections.
The tests cannot establish that an unreachable relay or a sleeping computer can
remain online. Recovery requires a running process and a working network route.
Alpine tunnel recovery can be tested, but automatic plugin service supervision
still requires a supported init system. No official release is implied by this
report.
