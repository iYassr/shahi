/**
 * The server the tests talk to.
 *
 * Same contract as the real one, none of the consequences: no herdr socket, no
 * agents, and every write recorded rather than performed. It serves the real
 * built client, so what runs in the browser is exactly what runs on the phone —
 * only what is behind it is fake.
 *
 * Why this exists: the suite used to run against the live session. That made
 * every test non-deterministic (the top row changes as agents work), left whole
 * situations untestable (there is no blocked agent to hand when you need one),
 * and on one occasion let mocked writes escape into somebody's actual work.
 *
 *   bun run e2e/stub/server.ts            # port 7272
 *   PORT=8080 bun run e2e/stub/server.ts
 *
 * Tests drive it through `/__stub/*`: set a scenario, read back what the app
 * tried to write, or push an event down the socket.
 */
import { SHAHI_API_VERSION } from "@shahi/shared";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { SCENARIOS, type Scenario, type ScenarioName } from "./data";

const PORT = Number(process.env.PORT ?? 7272);
const WEB_ROOT = process.env.STUB_WEB_ROOT ?? join(import.meta.dir, "../../web/dist");
// Digits, because the app's passcode field is a number pad — real passcodes
// are generated as digits, and Maestro cannot type letters on an iOS number
// pad. "test" here meant the native flows could never sign in.
const PASSCODE = "1234";
const COOKIE = "shahi_session=stub";
// One fixed pairing code, so a flow can pair without a server printing one.
const PAIR_SECRET = "stub-pair";

let scenario: Scenario = SCENARIOS.busy();
/**
 * The contract range `/api/meta` advertises and requests are held to.
 *
 * The real server speaks exactly one version; the stub can be told to speak
 * some other range so the app can be shown a server it cannot talk to —
 * which is the one situation nothing but a mismatch can stage. Reset with the
 * scenario, so an override cannot leak into the next test.
 */
const APP_SPEAKS = { min: SHAHI_API_VERSION, max: SHAHI_API_VERSION };
let apiRange = { ...APP_SPEAKS };
/** Everything the app tried to change, in order, for tests to assert on. */
let writes: { method: string; path: string; body: unknown; at: number }[] = [];
const sockets = new Set<ServerWebSocket<unknown>>();

/** Files the file viewer can open, written once into a temp directory. */
const files = mkdtempSync(join(tmpdir(), "shahi-stub-"));
writeFileSync(join(files, "prompt-parser.ts"), "const OPTION_RE = /^\\s*(\\d+)\\.\\s+(.+)$/;\n");
writeFileSync(join(files, "notes.md"), "# Notes\n\nA file the agent wrote.\n");
// A 240x160 PNG, so "is the thumbnail drawn?" can fail honestly.
const PNG = Buffer.from(
  "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",
  "base64",
);
writeFileSync(join(files, "shot.png"), PNG);

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });

const authorised = (req: Request) => (req.headers.get("cookie") ?? "").includes("shahi_session=");

const record = async (req: Request, path: string) => {
  writes.push({
    method: req.method,
    path,
    body: await req.json().catch(() => null),
    at: Date.now(),
  });
};

const broadcast = (message: unknown) => {
  const payload = JSON.stringify(message);
  for (const socket of sockets) socket.send(payload);
};

/** Substitutes the temp-directory paths into a transcript's file references. */
function withRealFiles(messages: Scenario["transcripts"][string]): Scenario["transcripts"][string] {
  return messages.map((message) => ({
    ...message,
    blocks: message.blocks.map((block) => {
      if (block.kind !== "tool" || !block.file) return block;
      return { ...block, file: { ...block.file, path: join(files, block.file.name) } };
    }),
  }));
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 60,

  async fetch(req, server) {
    const url = new URL(req.url);
    const { pathname } = url;

    /* ---------------------------------------------------------- control -- */

    if (pathname === "/__stub/scenario" && req.method === "POST") {
      const body = (await req.json()) as { name?: ScenarioName; patch?: Partial<Scenario> };
      if (body.name) scenario = SCENARIOS[body.name]();
      if (body.patch) scenario = { ...scenario, ...body.patch };
      apiRange = { ...APP_SPEAKS };
      writes = [];
      broadcast({ type: "session", session: scenario.session });
      return json({ ok: true });
    }

    if (pathname === "/__stub/writes") return json({ writes });

    if (pathname === "/__stub/meta" && req.method === "POST") {
      // Advertise a contract range and refuse everything outside it — a
      // server behind the app (`{ min: 0, max: 0 }`) or far ahead of it
      // (`{ min: 99, max: 99 }`), until the next scenario resets it.
      const body = (await req.json()) as { api?: { min: number; max: number } };
      if (!body.api || !Number.isInteger(body.api.min) || !Number.isInteger(body.api.max)) {
        return json({ error: "api: { min, max } required" }, { status: 400 });
      }
      apiRange = { min: body.api.min, max: body.api.max };
      // A real sidecar cannot change its compiled API range in place: an
      // upgrade restarts it and therefore drops every existing socket. Mirror
      // that here so the signed-in upgrade scenario exercises reconnection,
      // rather than leaving an impossible old socket streaming new-version
      // data forever.
      for (const socket of sockets) socket.close();
      return json({ ok: true, api: apiRange });
    }

    if (pathname === "/__stub/push" && req.method === "POST") {
      // Lets a test push a frame, a prompt or a status change down the socket.
      broadcast(await req.json());
      return json({ ok: true });
    }

    if (pathname === "/__stub/drop" && req.method === "POST") {
      // Kills every connection, so recovery can be tested honestly.
      for (const socket of sockets) socket.close();
      return json({ ok: true, dropped: sockets.size });
    }

    /* ------------------------------------------------------------- auth -- */

    // The handshake, before any authentication: what this server is and which
    // contract versions it speaks. The values mirror the real server's shape;
    // the app compares them before it ever asks for a passcode.
    if (pathname === "/api/meta") {
      return json({
        serverId: "stub-0000",
        serverVersion: "0.1.0",
        api: apiRange,
        herdr: { version: scenario.session.version, protocol: scenario.session.protocol },
      });
    }

    // The version gate, in the same place and the same words as the real
    // server's: before auth, before the socket upgrade, on any request that
    // names a version. Both product clients name the shared version.
    const claimed = req.headers.get("x-shahi-api");
    if (claimed !== null) {
      const n = Number(claimed);
      if (!Number.isInteger(n) || n < apiRange.min || n > apiRange.max) {
        return json(
          {
            error:
              n > apiRange.max
                ? "This server runs an older Shahi than the app. Update Shahi on this computer — run herdr plugin install iYassr/shahi again."
                : "This app is older than the Shahi on this server. Update the app.",
            api: apiRange,
          },
          { status: 426 },
        );
      }
    }

    if (pathname === "/api/auth/status") {
      return json({ required: true, authenticated: authorised(req) });
    }

    if (pathname === "/api/auth/login" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { passcode?: string };
      if (body.passcode !== PASSCODE) return json({ error: "wrong passcode" }, { status: 401 });
      return json({ ok: true }, { headers: { "set-cookie": `${COOKIE}; Path=/; HttpOnly` } });
    }

    if (pathname === "/api/auth/logout" && req.method === "POST") {
      await record(req, pathname);
      return json({ ok: true }, { headers: { "set-cookie": "shahi_session=; Path=/; HttpOnly; Max-Age=0" } });
    }

    // Pairing, unauthenticated like the real route: the right secret is a
    // session, anything else is the same 401 the server gives a spent code.
    if (pathname === "/api/pair/claim" && req.method === "POST") {
      await record(req, pathname);
      const body = writes[writes.length - 1]!.body as { secret?: string; deviceName?: string } | null;
      if (body?.secret !== PAIR_SECRET) return json({ error: "That pairing code is not valid." }, { status: 401 });
      return json(
        { device: { id: "dev-stub", name: body.deviceName ?? "Phone", createdAt: Date.now(), lastSeenAt: Date.now() } },
        { headers: { "set-cookie": `${COOKIE}; Path=/; HttpOnly` } },
      );
    }

    if (pathname.startsWith("/api/") || pathname === "/ws") {
      if (!authorised(req)) return json({ error: "unauthorized" }, { status: 401 });
    }

    if (pathname === "/api/pair" && req.method === "POST") {
      return json({ secret: PAIR_SECRET, expiresAt: Date.now() + 600_000 });
    }

    // A passcode login's view by default: no devices, and not one itself.
    if (pathname === "/api/devices" && req.method === "GET") {
      return json({ devices: [], thisDeviceId: null });
    }

    const device = pathname.match(/^\/api\/devices\/([^/]+)$/);
    if (device && req.method === "DELETE") {
      await record(req, pathname);
      return json({ ok: true });
    }

    if (pathname === "/ws") {
      return server.upgrade(req) ? undefined : new Response("expected upgrade", { status: 400 });
    }

    /* -------------------------------------------------------------- app -- */

    if (pathname === "/api/session") return json(scenario.session);

    if (pathname === "/api/agents") {
      return json({ agents: [{ kind: "claude", command: "/usr/bin/claude" }], known: 19 });
    }

    if (pathname === "/api/dirs") {
      return json({
        path: "/home/x",
        display: "~",
        parent: null,
        entries: [
          { name: "project", path: "/home/x/project", display: "~/project", isDirectory: true },
          { name: "notes.md", path: join(files, "notes.md"), display: "~/notes.md", isDirectory: false, size: 32 },
        ],
      });
    }

    if (pathname === "/api/file") {
      const path = url.searchParams.get("path") ?? "";
      if (!path.startsWith(files)) return json({ error: "outside the roots" }, { status: 403 });
      const file = Bun.file(path);
      if (!(await file.exists())) return json({ error: "not found" }, { status: 404 });
      const download = url.searchParams.get("download") === "1";
      const name = path.slice(path.lastIndexOf("/") + 1);
      return new Response(file, {
        headers: {
          "content-type": download
            ? "application/octet-stream"
            : name.endsWith(".png")
              ? "image/png"
              : "text/plain; charset=utf-8",
          "content-disposition": `${download ? "attachment" : "inline"}; filename="${name}"`,
        },
      });
    }

    const pane = pathname.match(/^\/api\/panes\/([^/]+)(\/[a-z]+)?$/);
    if (pane) {
      const paneId = decodeURIComponent(pane[1]!);
      const sub = pane[2];
      const known = scenario.session.panes.find((p) => p.paneId === paneId);

      if (sub === "/session") {
        const all = scenario.transcripts[paneId];
        if (!all) return json({ error: "no transcript", messages: [] }, { status: 404 });

        const withFiles = withRealFiles(all);
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 60), 400);
        const before = url.searchParams.get("before");
        const end = before ? Number(before) : withFiles.length;
        const start = Math.max(0, end - limit);
        return json({
          sessionId: `stub-${paneId}`,
          path: `/home/x/.claude/projects/${paneId}.jsonl`,
          messages: withFiles.slice(start, end),
          total: withFiles.length,
          offset: JSON.stringify(withFiles).length,
        });
      }

      if (sub === "/transcript") {
        return json({
          paneId,
          total: 3,
          lines: [
            { seq: 1, text: "$ bun test", at: 1 },
            { seq: 2, text: "184 pass", at: 2 },
            { seq: 3, text: "0 fail", at: 3 },
          ],
        });
      }

      if (sub === "/image") {
        return new Response(PNG, { headers: { "content-type": "image/png" } });
      }

      if (!sub) {
        if (!known) return json({ error: "no such pane" }, { status: 404 });
        const screen = scenario.screens[paneId] ?? "";
        return json({
          pane: {
            pane_id: paneId,
            agent_status: known.status,
            cwd: known.cwd,
            agent: known.agent,
          },
          agent: known.agent ? { name: known.agent } : null,
          layout: { area: { width: 146, height: 42 } },
          frame: {
            paneId,
            ansi: screen,
            text: screen.replace(/\x1b\[[0-9;]*m/g, ""),
            prompt: scenario.prompts[paneId] ?? null,
            activity:
              known.status === "working"
                ? { verb: "Baking", elapsed: "8m 34s", detail: "26.0k tokens" }
                : null,
            at: Date.now(),
          },
        });
      }
    }

    /* ------------------------------------------------------------ writes -- */

    // The semantic routes the native app uses. One prompt is one request; the
    // server, not the phone, knows about herdr methods and codex's paste delay.
    const paneWrite = pathname.match(/^\/api\/panes\/([^/]+)\/(prompt|keys|answer)$/);
    if (paneWrite && req.method === "POST") {
      await record(req, pathname);
      const body = writes[writes.length - 1]!.body as { clientMessageId?: string } | null;
      return paneWrite[2] === "prompt"
        ? json({ accepted: true, clientMessageId: body?.clientMessageId ?? "", acceptedAt: Date.now() })
        : json({ ok: true });
    }

    if (pathname === "/api/workspaces" && req.method === "POST") {
      await record(req, pathname);
      return json({ workspaceId: "w9" });
    }

    if ((/^\/api\/workspaces\/[^/]+\/tabs$/.test(pathname)) && req.method === "POST") { await record(req, pathname); return json({ workspaceId: "w9", paneId: "w1:p9", tabId: "w1:t9" }); }
    // Debugging endpoint; both product clients use semantic routes.
    if (pathname === "/api/rpc" && req.method === "POST") {
      await record(req, pathname);
      return json({ result: { type: "ok" } });
    }

    if (pathname === "/api/agents/start" && req.method === "POST") {
      await record(req, pathname);
      return json({ paneId: "w1:p9", tabId: "w1:t9" });
    }

    if (pathname === "/api/uploads" && req.method === "POST") {
      writes.push({ method: "POST", path: pathname, body: "(multipart)", at: Date.now() });
      return json({
        name: "photo.png",
        path: join(files, "shot.png"),
        size: PNG.byteLength,
        type: "image/png",
      });
    }

    if (pathname.startsWith("/api/push/")) {
      if (req.method === "POST") await record(req, pathname);
      return pathname.endsWith("/key") ? json({ publicKey: null }) : json({ ok: true });
    }

    if (pathname.startsWith("/api/")) return json({ error: "not found" }, { status: 404 });

    /* -------------------------------------------------------------- web -- */

    const relative = pathname.replace(/^\/+/, "");
    const candidate = Bun.file(`${WEB_ROOT}/${relative}`);
    if (relative && (await candidate.exists())) {
      return new Response(candidate, {
        headers: {
          "cache-control": /\.[0-9a-f]{8,}\./.test(relative)
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        },
      });
    }
    return new Response(Bun.file(`${WEB_ROOT}/index.html`), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
    });
  },

  websocket: {
    idleTimeout: 60,
    open(socket) {
      sockets.add(socket);
      socket.send(JSON.stringify({ type: "session", session: scenario.session }));
    },
    close(socket) {
      sockets.delete(socket);
    },
    message() {
      // watch / unwatch: the stub polls nothing, so there is nothing to change.
    },
  },
});

// Heartbeat, matching the real server's contract.
setInterval(() => broadcast({ type: "ping", at: Date.now() }), 20_000);

console.log(`stub shahi on http://127.0.0.1:${PORT} (passcode ${PASSCODE}, files in ${files})`);
