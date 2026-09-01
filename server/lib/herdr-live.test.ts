/**
 * Shahi's dependencies on herdr, exercised against a real herdr.
 *
 * The rest of the suite runs against a stub, which is what makes it fast and
 * safe — and which means it cannot notice the day herdr starts answering
 * differently. Every entry in CLAUDE.md's "what herdr actually does, as
 * measured" was found by hand and cost an afternoon; this is the same list,
 * run by a machine on every push against a pinned herdr and the current stable,
 * and nightly against the preview channel.
 *
 * It writes — into a scratch workspace it creates and closes, on a herdr it is
 * pointed at explicitly, which must be a *named session*:
 *
 *   herdr --session shahi-ci server &
 *   export HERDR_SOCKET_PATH=$HOME/.config/herdr/sessions/shahi-ci/herdr.sock
 *   SHAHI_HERDR_LIVE=1 bun test server/lib/herdr-live.test.ts
 *
 * Both variables are required on purpose: without an explicit socket the
 * client would pick up the default session, and a scratch workspace appearing
 * in somebody's real session is not something a test should ever do. And the
 * session must be named, not just a socket override: `HERDR_SOCKET_PATH=/tmp/x
 * herdr server` restores the default session's saved state and re-launches its
 * agents as duplicates (measured: four extra `claude --resume` processes).
 *
 * SHAHI_HERDR_PREVIEW=1 relaxes the exact-protocol check to `>=`, so the
 * nightly run reports a protocol bump without failing on the bump alone —
 * the behaviours below are what has to keep working.
 *
 * SHAHI_HERDR_LIVE_AGENT=1 adds the one test that needs an agent: it starts
 * a claude in the scratch workspace and proves a prompt reaches it through
 * `agent.prompt` rather than the terminal. Off by default because the CI
 * runners have no `claude` to start, and because the prompt costs tokens on
 * whatever account that `claude` is signed in as. By hand, on a Mac or box
 * with claude on PATH and the named session above running:
 *
 *   SHAHI_HERDR_LIVE=1 SHAHI_HERDR_LIVE_AGENT=1 bun test server/lib/herdr-live.test.ts
 */
import { SHAHI_API_VERSION } from "@shahi/shared";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrClient, HerdrError, HerdrSubscriber, type AnyEvent } from "./herdr-client";
import { HERDR_PROTOCOL } from "./herdr-schema";
import { SessionStore } from "./state";
import { Poller } from "./poller";
import { TranscriptStore } from "./transcript";
import { dashboard } from "./http";
import { submitPrompt } from "./prompt";
import { startAgentInTab } from "./agents";

const LIVE = process.env.SHAHI_HERDR_LIVE === "1";
const LIVE_AGENT = process.env.SHAHI_HERDR_LIVE_AGENT === "1";
const PREVIEW = process.env.SHAHI_HERDR_PREVIEW === "1";
const SOCKET = process.env.HERDR_SOCKET_PATH;

const KNOWN_STATUSES = new Set(["idle", "working", "blocked", "done", "unknown"]);

/** Polls `read` until it satisfies `ok` or the deadline passes; returns the last value. */
async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last = await read();
  while (!ok(last) && Date.now() < deadline) {
    await Bun.sleep(150);
    last = await read();
  }
  return last;
}

describe.skipIf(!LIVE)("against a real herdr", () => {
  if (LIVE && !SOCKET) {
    throw new Error("SHAHI_HERDR_LIVE=1 needs HERDR_SOCKET_PATH pointing at a herdr started for this purpose");
  }
  const client = new HerdrClient({ socketPath: SOCKET });
  const scratchDir = mkdtempSync(join(tmpdir(), "shahi-live-"));
  const nonce = Math.random().toString(36).slice(2, 10);
  let workspaceId = "";
  let paneId = "";

  const visible = async (id: string) =>
    (await client.rpc("pane.read", { pane_id: id, source: "visible", format: "text", strip_ansi: true })).read.text;

  beforeAll(async () => {
    const created = await client.rpc("workspace.create", { label: `shahi-live-${nonce}`, cwd: scratchDir, focus: false });
    workspaceId = created.workspace.workspace_id;
    // `tab.create` answers with the tab's root pane — the same fact
    // `startAgentInTab` relies on.
    const tab = (await client.rpc("tab.create", { workspace_id: workspaceId, cwd: scratchDir, focus: false })) as {
      root_pane?: { pane_id: string };
    };
    paneId = tab.root_pane?.pane_id ?? "";
    if (!paneId) throw new Error("tab.create did not name a root pane");
    // The pane exists before its shell does (measured: agent.start races it).
    // Give the shell a moment to draw a prompt before typing at it.
    await eventually(() => visible(paneId), (text) => text.trim().length > 0, 8_000);
  });

  afterAll(async () => {
    if (workspaceId) await client.rpc("workspace.close", { workspace_id: workspaceId }).catch(() => undefined);
    rmSync(scratchDir, { recursive: true, force: true });
  });

  test("ping: the protocol these types were generated from", async () => {
    const { protocol, version } = await client.connect();
    expect(protocol).toBeGreaterThanOrEqual(HERDR_PROTOCOL);
    if (!PREVIEW) {
      // A newer stable means `bun run gen:types` and a read of the diff — the
      // job fails so that happens on purpose rather than by surprise.
      expect(protocol, `herdr ${version} speaks protocol ${protocol}; regenerate the types`).toBe(HERDR_PROTOCOL);
    }
  });

  test("session.snapshot carries the shapes the mirror is built from", async () => {
    const { snapshot } = await client.rpc("session.snapshot", {});
    expect(Array.isArray(snapshot.workspaces)).toBe(true);
    expect(Array.isArray(snapshot.panes)).toBe(true);
    expect(Array.isArray(snapshot.tabs)).toBe(true);
    expect(Array.isArray(snapshot.agents)).toBe(true);
    expect(Array.isArray(snapshot.layouts)).toBe(true);
    expect(typeof snapshot.protocol).toBe("number");
    expect(snapshot.workspaces.some((w) => w.workspace_id === workspaceId)).toBe(true);
    expect(snapshot.panes.some((p) => p.pane_id === paneId)).toBe(true);
  });

  test("the mirror and the dashboard projection accept what herdr sends", async () => {
    const store = new SessionStore(client);
    await store.resync();
    const pane = store.pane(paneId);
    expect(pane).toBeDefined();
    expect(KNOWN_STATUSES.has(pane!.agent_status)).toBe(true);
    const transcript = new TranscriptStore(join(scratchDir, "t.sqlite"));
    const poller = new Poller(client, store, transcript);
    const session = await dashboard(store, poller);
    const row = session.panes.find((p) => p.paneId === paneId);
    expect(row).toMatchObject({ workspaceId, isAgent: false });
    expect(KNOWN_STATUSES.has(row!.status)).toBe(true);
    expect(session.protocol).toBe((await client.connect()).protocol);
  });

  test("pane.read: visible text, and recent history that is at least the screen", async () => {
    const text = await visible(paneId);
    expect(text.length).toBeGreaterThan(0);
    const recent = await client.rpc("pane.read", { pane_id: paneId, source: "recent", format: "text", strip_ansi: true, lines: 1000 });
    expect(recent.read.text.length).toBeGreaterThan(0);
    const ansi = await client.rpc("pane.read", { pane_id: paneId, source: "visible", format: "ansi", strip_ansi: false });
    expect(typeof ansi.read.text).toBe("string");
  });

  test("a prompt to a shell is typed and submitted, and the shell ran it", async () => {
    const rpc = (method: string, params: Record<string, unknown>) =>
      client.rpc(method as never, params as never) as Promise<unknown>;
    const path = await submitPrompt(rpc, { paneId, isAgent: false, status: null }, `printf 'shahi-ran-%s\\n' ${nonce}`);
    expect(path).toBe("terminal");
    const text = await eventually(() => visible(paneId), (t) => t.includes(`shahi-ran-${nonce}`));
    expect(text).toContain(`shahi-ran-${nonce}`);
  });

  test("agent.prompt refuses a pane that is not an agent, with a code", async () => {
    let caught: unknown;
    try {
      await client.rpc("agent.prompt", { target: paneId, text: "hello" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HerdrError);
    expect(typeof (caught as HerdrError).code).toBe("string");
  });

  /**
   * The path the shell above cannot take. `submitPrompt` chooses `agent.prompt`
   * for an agent that is not blocked, and CLAUDE.md records that call as the
   * one thing the live suite has never exercised. This starts a real claude
   * the way the phone does — `startAgentInTab`, with its retry around the
   * shell race — and sends it one short prompt with no `wait`, which is the
   * receipt-not-reply contract the phone relies on.
   */
  describe.skipIf(!LIVE_AGENT)("with a real agent", () => {
    test(
      "submitPrompt takes the agent path, and agent.prompt is accepted without a wait",
      async () => {
        const started = await startAgentInTab(
          (method, params, options) => client.rpc(method as never, params as never, options) as never,
          {
            workspaceId,
            cwd: scratchDir,
            label: `shahi-live-agent-${nonce}`,
            kind: "claude",
            name: "claude",
            mode: null,
          },
        );
        const agentPane = started.paneId;

        const store = new SessionStore(client);
        const status = async () => {
          await store.resync();
          return store.agent(agentPane)?.agent_status ?? "unknown";
        };
        // herdr answers `agent.start` once the agent is interactively ready —
        // and in a directory it has never seen, claude's first interactive
        // screen is the trust question, which herdr reports as `blocked`. A
        // blocked agent takes the terminal path by design, so answer it the
        // way a person would: Enter accepts the default on the test's own
        // empty directory. Anything else that blocks is left alone and fails
        // below, naming the pane rather than printing its screen.
        let current = await eventually(status, (s) => s !== "unknown", 20_000);
        if (current === "blocked" && /trust/i.test(await visible(agentPane))) {
          await client.rpc("pane.send_keys", { pane_id: agentPane, keys: ["Enter"] });
          current = await eventually(status, (s) => s !== "blocked", 20_000);
        }
        expect(
          current,
          `claude in ${agentPane} is ${current}; the agent path needs it promptable — open the pane in herdr to see what it is asking`,
        ).not.toBe("blocked");
        expect(store.agent(agentPane)).toBeDefined();

        const rpc = (method: string, params: Record<string, unknown>) =>
          client.rpc(method as never, params as never) as Promise<unknown>;
        const marker = `shahi-agent-${nonce}`;
        const path = await submitPrompt(
          rpc,
          { paneId: agentPane, isAgent: true, status: current },
          `Reply with exactly the word ${marker} and nothing else.`,
        );
        expect(path).toBe("agent");

        // Delivered, not just accepted: the prompt is on the agent's screen.
        // The reply itself is not waited for — that is the transcript's job,
        // and this test proves the send, not claude.
        const screen = await eventually(() => visible(agentPane), (t) => t.includes(marker), 15_000);
        // Not `toContain`: a failure would print the agent's screen into CI.
        expect(screen.includes(marker), `prompt did not reach ${agentPane} within 15s — open the pane in herdr`).toBe(true);
      },
      // `agent.start` blocks until the agent is interactively ready, and a
      // cold claude on a slow box can take most of a minute.
      360_000,
    );
  });

  // Every name the key bar offers has to be one herdr accepts: `S-Tab` was
  // refused as invalid_key once, `shift+tab` is the spelling that works.
  test.each([["Enter"], ["Escape"], ["shift+tab"], ["ctrl+c"], ["up"], ["down"], ["tab"]])(
    "pane.send_keys accepts %j",
    async (key) => {
      await client.rpc("pane.send_keys", { pane_id: paneId, keys: [key] });
    },
  );

  test("events.subscribe streams, and acknowledges with a resync", async () => {
    const events: AnyEvent[] = [];
    let resyncs = 0;
    // The subscriber reads HERDR_SOCKET_PATH itself, at module load — the same
    // variable this suite requires — so it is on the scratch server too.
    const sub = new HerdrSubscriber({
      onEvent: (e) => events.push(e),
      onResync: () => void resyncs++,
      onError: () => undefined,
    });
    sub.start();
    try {
      await client.rpc("pane.send_text", { pane_id: paneId, text: `echo shahi-event-${nonce}` });
      await client.rpc("pane.send_keys", { pane_id: paneId, keys: ["Enter"] });
      await eventually(async () => events.length, (n) => n > 0, 8_000);
    } finally {
      sub.stop();
    }
    expect(resyncs).toBeGreaterThanOrEqual(1);
    expect(events.length).toBeGreaterThan(0);
  });

  test("concurrent RPCs each get their own connection", async () => {
    const answers = await Promise.all([
      client.rpc("workspace.list", {}),
      client.rpc("pane.list", { workspace_id: null }),
      client.rpc("agent.list", {}),
    ]);
    expect(answers).toHaveLength(3);
  });

  /**
   * The sidecar itself, over HTTP, against this herdr: what a phone would see.
   * Auth is off (no passcode hash) because the thing under test is the
   * herdr-facing behaviour, and the passcode has its own suite.
   */
  describe("the sidecar over HTTP", () => {
    let child: ReturnType<typeof Bun.spawn> | null = null;
    let base = "";

    beforeAll(async () => {
      const port = 17_000 + Math.floor(Math.random() * 1_000);
      base = `http://127.0.0.1:${port}`;
      child = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "index.ts")], {
        env: {
          ...process.env,
          PORT: String(port),
          HERDR_SOCKET_PATH: SOCKET!,
          SESSION_SECRET: "live-test-secret",
          SHAHI_DATA: join(scratchDir, "shahi.sqlite"),
          PASSCODE_HASH_B64: "",
        },
        // Inherited, not piped: under `bun test` on macOS a piped child fails
        // at posix_spawn with EBADF (the same runner fault that trips
        // `installedAgents`, see docs/on-a-mac.md). The sidecar's startup lines
        // carry counts and paths, never pane content, so they can share the
        // test's output.
        stdout: "inherit",
        stderr: "inherit",
      });
      const up = await eventually(
        () => fetch(`${base}/api/meta`).then((r) => r.ok).catch(() => false),
        (ok) => ok,
        15_000,
      );
      if (!up) throw new Error(`sidecar did not come up on ${base}; its output is above`);
    });

    afterAll(() => child?.kill());

    test("GET /api/meta describes the server before any login", async () => {
      const info = (await (await fetch(`${base}/api/meta`)).json()) as {
        serverId: string;
        serverVersion: string;
        api: { min: number; max: number };
        herdr: { version: string; protocol: number };
      };
      // base64url(sha256(box key)): 43 characters, the id a relay can verify.
      expect(info.serverId).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(info.api.min).toBeLessThanOrEqual(SHAHI_API_VERSION);
      expect(info.api.max).toBeGreaterThanOrEqual(SHAHI_API_VERSION);
      expect(info.herdr.protocol).toBeGreaterThanOrEqual(HERDR_PROTOCOL);
      expect(typeof info.herdr.version).toBe("string");
    });

    test("a contract version the server does not speak is a 426, not a mystery", async () => {
      const res = await fetch(`${base}/api/session`, { headers: { "x-shahi-api": "99" } });
      expect(res.status).toBe(426);
      const body = (await res.json()) as { error: string; api: { min: number; max: number } };
      expect(body.error).toMatch(/Update/);
      expect(body.api.min).toBeLessThanOrEqual(body.api.max);
    });

    test("GET /api/session lists the scratch pane", async () => {
      const session = (await (await fetch(`${base}/api/session`, { headers: { "x-shahi-api": String(SHAHI_API_VERSION) } })).json()) as {
        panes: { paneId: string; status: string }[];
      };
      const row = session.panes.find((p) => p.paneId === paneId);
      expect(row).toBeDefined();
      expect(KNOWN_STATUSES.has(row!.status)).toBe(true);
    });

    test("POST /api/panes/:id/prompt delivers once and answers a retry with the same receipt", async () => {
      const body = JSON.stringify({ text: `printf 'shahi-http-%s\\n' ${nonce}`, clientMessageId: `cm-${nonce}` });
      const headers = { "content-type": "application/json", "x-shahi-api": String(SHAHI_API_VERSION) };
      const first = (await (await fetch(`${base}/api/panes/${encodeURIComponent(paneId)}/prompt`, { method: "POST", headers, body })).json()) as {
        accepted: boolean;
        clientMessageId: string;
        acceptedAt: number;
      };
      expect(first).toMatchObject({ accepted: true, clientMessageId: `cm-${nonce}` });
      const again = await (await fetch(`${base}/api/panes/${encodeURIComponent(paneId)}/prompt`, { method: "POST", headers, body })).json();
      expect(again).toEqual(first);
      const text = await eventually(() => visible(paneId), (t) => t.includes(`shahi-http-${nonce}`));
      expect(text).toContain(`shahi-http-${nonce}`);
    });

    test("POST /api/panes/:id/keys and /api/workspaces go through", async () => {
      const headers = { "content-type": "application/json", "x-shahi-api": String(SHAHI_API_VERSION) };
      const keys = await fetch(`${base}/api/panes/${encodeURIComponent(paneId)}/keys`, {
        method: "POST",
        headers,
        body: JSON.stringify({ keys: ["Enter"] }),
      });
      expect(keys.status).toBe(200);
      const created = (await (await fetch(`${base}/api/workspaces`, {
        method: "POST",
        headers,
        body: JSON.stringify({ label: `shahi-live-http-${nonce}`, cwd: scratchDir }),
      })).json()) as { workspaceId: string };
      expect(typeof created.workspaceId).toBe("string");
      await client.rpc("workspace.close", { workspace_id: created.workspaceId });
      const relative = await fetch(`${base}/api/workspaces`, { method: "POST", headers, body: JSON.stringify({ cwd: "~/x" }) });
      expect(relative.status).toBe(400);
    });
  });
});
