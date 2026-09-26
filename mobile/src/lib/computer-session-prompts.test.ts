/**
 * What a computer's waiting cards offer, as messages arrive.
 *
 * The pre-release bug hunt slept a phone through a new question (answered A at
 * the laptop, the agent then asked B) and found A's options on the card after
 * reconnecting, although `/api/session` said B. Every tap was refused with 409
 * and the card kept offering them until the app was reloaded. The computer
 * kept a remembered prompt over the snapshot's for as long as the pane was
 * blocked, and only a one-off `prompt` push could replace it.
 */
import type { DashboardPane, ParsedPrompt, Session, SocketMessage } from "@shahi/shared";
import { ComputerSession } from "./computer-session";

const ask = (question: string): ParsedPrompt => ({
  question, answer: "digit", options: [{ index: 1, label: "Yes", selected: true }, { index: 2, label: "No", selected: false }],
});
const A = ask("Run the migration?");
const B = ask("Delete the old table?");
const pane = (status: DashboardPane["status"], prompt: ParsedPrompt | null): DashboardPane => ({
  paneId: "w1:p1", workspaceId: "w1", workspaceLabel: "one", tabId: "t1", status, agent: "claude", title: "t", cwd: null,
  focused: false, hasPrompt: !!prompt, isAgent: true, prompt, preview: null, activity: null,
});
const session = (...panes: DashboardPane[]) => ({ panes, workspaces: [], tabs: [] } as unknown as Session);

function computer() {
  const c = new ComputerSession(
    { id: "c1", name: "Box", pins: [], connection: { kind: "relay", relay: "https://relay.example", serverId: "srv", deviceId: "d1", deviceSecret: "c2VjcmV0" } },
    () => {}, () => {},
  );
  const send = (msg: SocketMessage) => (c as unknown as { message(m: SocketMessage): void }).message(msg);
  return { c, send };
}

test("a waiting card follows the server's current question after reconnecting", () => {
  const { c, send } = computer();
  send({ type: "session", session: session(pane("blocked", A)) });
  send({ type: "prompt", paneId: "w1:p1", prompt: A });
  // Asleep through B: the next thing heard is the snapshot.
  send({ type: "session", session: session(pane("blocked", B)) });
  expect(c.prompts["w1:p1"]).toEqual(B);
  c.dispose();
});

test("a card whose menu left the screen while the pane still waits offers nothing", () => {
  const { c, send } = computer();
  send({ type: "prompt", paneId: "w1:p1", prompt: A });
  send({ type: "session", session: session(pane("blocked", null)) });
  expect(c.prompts).toEqual({});
  c.dispose();
});

test("an answered question is not brought back by the snapshot that still carries it", () => {
  const { c, send } = computer();
  send({ type: "session", session: session(pane("blocked", A)) });
  c.answeredPrompt("w1:p1", A, "sent");
  send({ type: "session", session: session({ ...pane("blocked", A), title: "changed" }) });
  expect(c.prompts).toEqual({});
  expect(c.answered["w1:p1"]?.outcome).toBe("sent");
  send({ type: "session", session: session(pane("working", null)) });
  expect(c.answered).toEqual({});
  c.dispose();
});
