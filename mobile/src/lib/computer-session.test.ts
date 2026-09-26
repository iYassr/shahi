/**
 * herdr reuses pane ids: close the highest space, restart herdr, create one,
 * and its panes have the old ids. The pre-release bug hunt found the app's
 * drafts, uncertain sends and remembered conversations following the id to
 * the new program. A computer's session forgets them as each list arrives,
 * before any screen renders it.
 */
import type { Session } from "@shahi/shared";
import { ComputerSession } from "./computer-session";
import type { SavedComputer } from "./computers";
import { clearNativeDrafts, nativeDraft } from "./drafts";
import { memoryOf } from "./reader-memory";

const saved: SavedComputer = {
  id: "box", name: "Box", pins: [],
  connection: { kind: "ssh", ssh: { host: "box.example", port: 22, username: "me", remotePort: 7171, passcode: "2468", auth: { kind: "password", password: "stub" } } },
};
const snapshot = (occupant: string, version = "0.9.1", isAgent = true) => ({
  version, protocol: 22, serverName: "box", defaultGrouping: null, workspaces: [], tabs: [], focusedPaneId: null,
  panes: [{ paneId: "w3:p1", instanceId: occupant, status: "idle", isAgent }, { paneId: "w1:p1", instanceId: "term_x", status: "idle", isAgent: true }],
}) as unknown as Session;

function computerAnswering(...sessions: Session[]) {
  const computer = new ComputerSession(saved, () => {}, () => {});
  (computer.api as unknown as { session: () => Promise<Session> }).session = jest.fn(async () => sessions.shift()!);
  return computer;
}

test("an unsent draft, its uncertain send and the remembered conversation do not follow a pane id to the next program", async () => {
  const computer = computerAnswering(snapshot("term_a"), snapshot("term_b"));
  await computer.refresh();
  const draft = nativeDraft(computer.api, "w3:p1");
  draft.text = "A-DRAFT: roll back the payments hotfix on prod";
  draft.pending = { key: "k", id: "retry-id", instanceId: "term_a" };
  memoryOf(computer.api).messages.set("w3:p1", { transcript: "s-a", messages: [] });
  const other = nativeDraft(computer.api, "w1:p1");
  other.text = "for the conversation still there";

  await computer.refresh();

  expect(nativeDraft(computer.api, "w3:p1").text).toBe("");
  expect(nativeDraft(computer.api, "w3:p1").pending).toBeNull();
  expect(memoryOf(computer.api).messages.has("w3:p1")).toBe(false);
  expect(nativeDraft(computer.api, "w1:p1").text).toBe("for the conversation still there");
  clearNativeDrafts(computer.api);
  computer.dispose();
});

test("a draft is kept while its conversation runs, and through the empty list a restarted sidecar sends first", async () => {
  const computer = computerAnswering(snapshot("term_a"), { ...snapshot("term_a", ""), panes: [] } as Session, snapshot("term_a"));
  await computer.refresh();
  nativeDraft(computer.api, "w3:p1").text = "still writing";
  await computer.refresh();
  await computer.refresh();
  expect(nativeDraft(computer.api, "w3:p1").text).toBe("still writing");
  clearNativeDrafts(computer.api);
  computer.dispose();
});

// Same terminal, so the same occupant: the agent quit and left its shell. The
// dead conversation opened every time over a composer that runs commands.
test("the conversation of an agent that quit is not remembered for the shell it left", async () => {
  const computer = computerAnswering(snapshot("term_a"), snapshot("term_a", "0.9.1", false));
  await computer.refresh();
  memoryOf(computer.api).messages.set("w3:p1", { transcript: "s-a", messages: [] });
  nativeDraft(computer.api, "w3:p1").text = "typed, and kept";
  await computer.refresh();
  expect(memoryOf(computer.api).messages.has("w3:p1")).toBe(false);
  expect(nativeDraft(computer.api, "w3:p1").text).toBe("typed, and kept");
  clearNativeDrafts(computer.api);
  computer.dispose();
});
