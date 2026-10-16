// Moves the showcase fixture on while a clip records, the way a computer would
// after the phone acts: the stub records writes and changes nothing, so an
// answered prompt would otherwise stay on screen.
//
//   bun marketing/video/capture/stub.ts answered    the edit is approved; the agent works on
//   bun marketing/video/capture/stub.ts reset       back to the showcase as chosen
//
// Run from the repository root, against the fixture capture.ts starts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { showcaseSession } from "../../../e2e/stub/showcase";

const STUB = `http://127.0.0.1:${Number(process.env.FIXTURE_PORT ?? 7572) + 1}`;
const CONTROL = readFileSync(join(import.meta.dirname, "../../app-store/control.json"), "utf8");

async function post(path: string, body: unknown) {
  const res = await fetch(`${STUB}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
}

/** A scenario change clears the handshake, which hides Changes; post it again. */
async function choose(patch: object) {
  await post("/__stub/scenario", { patch });
  await post("/__stub/control", CONTROL);
}

const what = process.argv[2];
if (what === "answered") {
  const s = showcaseSession();
  const pane = s.session.panes.find((p) => p.paneId === "w3:p4")!;
  Object.assign(pane, { status: "working", hasPrompt: false, prompt: null, preview: "Edit applied. Flushing the queue now stops at the first change it cannot send.", lastMessageAt: Date.now() });
  s.session.workspaces.find((w) => w.workspaceId === "w3")!.status = "working";
  s.session.tabs.find((t) => t.tabId === pane.tabId)!.status = "working";
  const { "w3:p4": _, ...prompts } = s.prompts;
  await choose({ session: s.session, prompts });
} else if (what === "reset") {
  await post("/__stub/scenario", { name: "showcase" });
  await post("/__stub/control", CONTROL);
} else {
  throw new Error("say answered or reset");
}
