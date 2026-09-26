/**
 * herdr reuses pane ids: close the highest space, restart herdr, create a
 * space, and its panes have the old ones' ids. The pre-release bug hunt found
 * the page's drafts and remembered conversations following the id to the new
 * program. Every session the app receives goes through
 * `forgetEndedConversations` before it renders.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { DashboardPane, Session } from "@shahi/shared";
import { ApiContext, ApiError, api, type SessionLog } from "./api";
import { clearWebDrafts, webDraft } from "./drafts";
import { forgetEndedConversations } from "./pane-occupants";
import { Reader, clearReaderMemory } from "./components/Reader";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const session = (...panes: Partial<DashboardPane>[]): Session => ({ version: "0.9.1", panes } as unknown as Session);
const held = session({ paneId: "w3:p1", instanceId: "term_a" }, { paneId: "w1:p1", instanceId: "term_x" });

let view: ReactTestRenderer | undefined;
const originals = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
  clearWebDrafts("direct");
  clearReaderMemory();
  for (const [key, value] of Object.entries({ window: new EventTarget(), document: Object.assign(new EventTarget(), { hidden: false }) })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
});
afterEach(async () => {
  if (view) await act(async () => view!.unmount());
  view = undefined;
  // Module state shared with every other test file in the run.
  clearWebDrafts("direct");
  clearReaderMemory();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});

test("an unsent draft and its uncertain send do not follow the pane id to the program that takes it", () => {
  const draft = webDraft("direct", "w3:p1");
  draft.text = "A-DRAFT: roll back the payments hotfix on prod";
  draft.pending = { body: draft.text, id: "retry-id", instanceId: "term_a" };
  const other = webDraft("direct", "w1:p1");
  other.text = "for the conversation still there";

  forgetEndedConversations(held, session({ paneId: "w3:p1", instanceId: "term_b" }, { paneId: "w1:p1", instanceId: "term_x" }));

  expect(webDraft("direct", "w3:p1").text).toBe("");
  expect(webDraft("direct", "w3:p1").pending).toBeNull();
  expect(webDraft("direct", "w1:p1").text).toBe("for the conversation still there");
});

test("a draft is kept while its conversation runs, and through the empty list a restarted sidecar sends first", () => {
  const draft = webDraft("direct", "w3:p1");
  draft.text = "still writing";
  forgetEndedConversations(held, structuredClone(held));
  forgetEndedConversations(held, { version: "", panes: [] } as unknown as Session);
  expect(webDraft("direct", "w3:p1").text).toBe("still writing");
});

const said = (text: string): SessionLog => ({ sessionId: "s-a", path: "/a.jsonl", total: 1, offset: 0, messages: [{ id: "a1", role: "agent", at: 0, blocks: [{ kind: "text", text }] }] });
const reader = (sessionLog: typeof api.sessionLog) => act(async () => {
  view = create(<ApiContext.Provider value={{ ...api, sessionLog }}><Reader paneId="w3:p1" activity={null} onUnavailable={() => {}} /></ApiContext.Provider>);
});
const output = () => JSON.stringify(view!.toJSON());

test("the reader never shows the previous occupant's conversation under a reused pane id, even while fetches fail", async () => {
  await reader(mock().mockResolvedValue(said("A: shall I roll back prod?")));
  expect(output()).toContain("A: shall I roll back prod?");
  await act(async () => view!.unmount());

  forgetEndedConversations(held, session({ paneId: "w3:p1", instanceId: "term_b" }));
  await reader(mock().mockRejectedValue(new ApiError("unavailable", 503)));
  expect(output()).not.toContain("A: shall I roll back prod?");
});

test("a pane with no conversation any more stops reopening on the dead one", async () => {
  await reader(mock().mockResolvedValue(said("A: shall I roll back prod?")));
  await act(async () => view!.unmount());
  // Same terminal, so the same occupant: the agent quit and left a shell.
  await reader(mock().mockRejectedValue(new ApiError("no transcript", 404)));
  await act(async () => view!.unmount());
  await reader(mock(() => new Promise<never>(() => {})));
  expect(output()).not.toContain("A: shall I roll back prod?");
  expect(output()).toContain("Reading the conversation");
});
