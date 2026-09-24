# Isolated review computer

This is a private Cloudflare Container for Apple review, separate from every
personal computer and from the production relay deployment. The existing Shahi
server and herdr run unmodified. Only the model replies are simulated.

The Codex CLI uses a local deterministic Responses endpoint. It has no AI account
or API key. Every answer identifies itself as simulated. `list files`, `read the
README`, and `create a sample file` request fixed real MCP file operations; other
messages receive an explanatory demo response. The two read-only demo tools are preapproved; file creation follows the
Codex client’s approval policy. These fixed tools do not exercise its Linux
shell sandbox. This is not a claim that arbitrary AI work is supported.

## Boundaries

- `review.getshahi.dev` requires a generated review password and mints fresh,
  one-use, ten-minute pairing codes. No credential appears in its URL.
- The app uses its usual encrypted relay connection, never a fake client API.
- A root controller supervises an unprivileged `demo` user. Worker and recovery
  credentials are not inherited by shells or agents.
- Only port 8080 (the authenticated controller) is exposed to the Worker.
  Shahi and the simulated provider listen on loopback inside the container.
- The build copies only explicit compiled server/controller assets and synthetic
  sample files. No host home directory, personal account, `.env`, or Git history
  is included.
- No AI provider credentials are used. The container still has outbound Internet
  access for the relay; this is a private review environment, not a public shell.
- Requests and transcripts are not logged to Cloudflare Observability.

## Recovery and retention

The controller saves a consistent SQLite backup plus regular sample workspace,
uploaded attachments, herdr configuration and transcript files to a private R2 bucket every 15 seconds.
The archive rejects links, traversal paths, special files and files outside its
allowlist, and has a 32 MiB uncompressed limit. A failed restore stops startup
rather than replacing the server identity. Sudden failure can lose changes since
the last successful snapshot; this is a review environment, not production data
backup. Health reports the last successful checkpoint and checkpoint failure.

One `standard-1` instance is kept available by a five-minute health schedule.
The schedule can recover a lost container within five minutes; opening the
pairing page also wakes it. On restart, herdr restores the layout and a fresh, labeled demo conversation
is started if no agent is active. Do not promise uninterrupted in-flight work across a host
failure. A controlled restart checkpoints first.

Access expires on 31 December 2026, extended from 19 October so App Store review and any resubmission fit inside it. The next scheduled cleanup stops the container
and deletes its recovery snapshot. Extending review requires changing
`REVIEW_EXPIRES_AT` and deploying. Delete the Worker/container and R2 bucket after
review to remove the schedule and provisioned resources entirely.

## Build and deploy

From the repository root:

```sh
npm ci --ignore-scripts --prefix demo
npm run typecheck --prefix demo
bun demo/build.ts
docker build --platform linux/amd64 -t shahi-review-demo:local demo
npx wrangler containers push shahi-review-demo:local
# Update demo/wrangler.toml with the returned immutable image digest.
demo/node_modules/.bin/wrangler deploy --config demo/wrangler.toml
```

The independent lockfile is intentional: container tooling is not shipped with
any Shahi client or plugin. The image pins Bun, herdr (including its digest) and
the Codex CLI. The root controller uses a strict environment allowlist for child
processes. Never give the demo a production AI key or personal login.

Worker secrets are `REVIEW_PASSWORD`, `INTERNAL_TOKEN`, `SESSION_SECRET`, and
`PASSCODE_HASH_B64`. Generate random values and upload them with Wrangler secret
bulk from a private file outside the repository. An incomplete deployment fails
closed until all four are set. Keep the operator token separate from reviewer
credentials. Review username: `reviewer`.

## Review instructions

1. Sign in to the private review page with the credentials in App Store Connect.
2. Create a fresh pairing code. Open its link on the iPhone, paste the code in
   Shahi, or scan its QR from another screen.
3. Open the Review demo space. Create a Codex agent and send `list files`.
4. Check Read and Screen, try another permission mode, send a small attachment,
   leave and reconnect, and remove the saved computer.
5. To pair again, return to the page and create a new code.

Explain the simulation explicitly in Apple review notes. This environment does
not guarantee Apple will accept simulated replies for review; do not claim
external approval until Apple provides it.

### Upload fallback for Docker-network failures

If Docker's VM loses its registry upload connection, a host-side OCI uploader
can push the exact same saved image without changing the application. Verify
the uploader's upstream release digest, refresh the registry credential through
Wrangler, push the image, and deploy the returned immutable registry digest.
Never disable TLS verification or put registry credentials in scripts/logs.

## Verification — 20 September 2026

The deployed Cloudflare environment passed one-time encrypted pairing,
saved-device reconnect, Codex creation, simulated response and real MCP tool
rendering in the reader API, and a 99 KB encrypted attachment upload with exact
byte comparison after download. A controlled cloud restart retained the saved
pairing and uploaded attachment. Login access, secure cookies, origin checks,
operator separation, Worker types, five model tests and four archive rejection
tests passed. The first rollout restart crossed from the old snapshot format;
the attachment persistence check was repeated against the updated image.

Authenticated browser visual verification remains incomplete: Chrome returned
`ERR_BLOCKED_BY_CLIENT` after submitting the sign-in form. The HTTP login and
cookie flow passed independently. Check Safari/iPhone sign-in and the complete
app flow before submitting external review; protocol tests do not replace this.
The App Store Connect private credentials/notes have not yet been updated.

The container has a provisioned running cost even though simulated replies
incur no AI-provider charges. Review expiry stops the container; remove the
Worker, container application and R2 bucket when the review is finished.
