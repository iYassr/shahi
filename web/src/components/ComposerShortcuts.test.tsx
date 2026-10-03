import { clearWebDrafts } from "../drafts";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ApiContext, api } from "../api";
import { ComputerControlProvider } from "./ComputerUpdate";
import { PaneView } from "./PaneView";

/**
 * The browser's composer shortcuts, held to what the phone's do (see
 * mobile/src/screens/pane-composer.test.tsx): the slash-command picker, and
 * one-tap replies while the agent waits on the next message.
 */
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let view: ReactTestRenderer | undefined;
const originals = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
  clearWebDrafts("direct");
  for (const [key, value] of Object.entries({ window: new EventTarget(), document: Object.assign(new EventTarget(), { hidden: false }) })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
});
afterEach(async () => {
  if (view) await act(async () => view!.unmount());
  view = undefined;
  clearWebDrafts("direct");
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key];
  }
});

let opened = 0;
const conversation = async () => ({ sessionId: "s", path: "p", total: 1, offset: 0, messages: [{ id: "a", role: "agent", at: 1, blocks: [{ kind: "text", text: "Shall I run the tests?" }] }] });
type Pane = { status?: string; isAgent?: boolean; agent?: string | null; hasPrompt?: boolean; lastMessageAt?: number | null };

/** Opens an agent's pane; each test its own pane id, since the Reader remembers by id. */
async function open({ pane = {}, capabilities, send = mock(async () => ({ accepted: true })), paneCommands = mock(async () => ({ commands: [] })) }: {
  pane?: Pane; capabilities?: string[]; send?: ReturnType<typeof mock>; paneCommands?: ReturnType<typeof mock>;
} = {}) {
  const paneId = `w7:p${++opened}`;
  const session = (over: Pane = {}) => ({ panes: [{ paneId, title: "Conversation", isAgent: true, agent: "claude", status: "idle", hasPrompt: false, instanceId: "i1", lastMessageAt: 1, ...pane, ...over }] }) as any;
  const detail = { pane: { pane_id: paneId, agent_status: "idle", agent: "claude" }, agent: null, layout: null, frame: null };
  const handshake = capabilities && { control: 1, serverId: "s", api: { min: 5, max: 5 }, capabilities, backend: { state: "connected", version: "0.9.1", protocol: 22 }, update: { managed: false, channel: "stable", phase: "idle", current: "dev" } };
  const scoped = { ...api, send, paneCommands, pane: mock(async () => detail), sessionLog: mock(conversation), ...(handshake ? { control: async () => handshake } : {}) };
  const tree = (over: Pane = {}) => {
    const page = <MemoryRouter initialEntries={[`/pane/${paneId}`]}><Routes><Route path="/pane/:paneId" element={<PaneView session={session(over)} frames={{}} prompts={{}} onWatch={mock()} onAnswer={mock()} onToast={mock()} />} /></Routes></MemoryRouter>;
    return <ApiContext.Provider value={scoped as any}>{handshake ? <ComputerControlProvider onRecovered={() => {}}>{page}</ComputerControlProvider> : page}</ApiContext.Provider>;
  };
  await act(async () => { view = create(tree()); });
  return { paneId, send, paneCommands, update: (over: Pane) => act(async () => view!.update(tree(over))) };
}

const textarea = () => view!.root.findByType("textarea");
const type = (value: string) => act(async () => textarea().props.onChange({ target: { value } }));
const key = (name: string) => {
  const event = { key: name, shiftKey: false, preventDefault: mock() };
  act(() => textarea().props.onKeyDown(event));
  return event;
};
const textOf = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : textOf(child)).join("");
const options = () => view!.root.findAll((n) => n.type === "button" && n.props.role === "option");
const chips = () => view!.root.findAll((n) => n.props.role === "group" && n.props["aria-label"] === "Quick replies");
const chip = (label: string) => view!.root.find((n) => n.type === "button" && (n.props["aria-label"] === label || textOf(n) === label));

describe("the slash-command picker", () => {
  test("typing / lists the agent's commands, typing on filters them, and choosing one fills the reply without sending it", async () => {
    const { send } = await open();
    expect(options()).toHaveLength(0);
    await type("/");
    expect(options().map((o) => textOf(o.children[0] as ReactTestInstance))).toContain("/compact");
    await type("/co");
    const names = options().map((o) => textOf(o.children[0] as ReactTestInstance));
    expect(names).toEqual(["/compact", "/context"]);
    await act(async () => options()[0]!.props.onClick());
    expect(textarea().props.value).toBe("/compact ");
    expect(options()).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  test("the arrow keys move through the list the composer controls, Enter chooses, and Escape closes it", async () => {
    await open();
    await type("/co");
    expect(textarea().props["aria-controls"]).toBe(view!.root.findByProps({ role: "listbox" }).props.id);
    expect(textarea().props["aria-activedescendant"]).toBeUndefined();
    // Enter before an option is lit is a new line, as everywhere in this composer.
    expect(key("Enter").preventDefault).not.toHaveBeenCalled();
    key("ArrowDown");
    key("ArrowDown");
    expect(options()[1]!.props["aria-selected"]).toBe(true);
    expect(textarea().props["aria-activedescendant"]).toBe(options()[1]!.props.id);
    key("ArrowUp");
    expect(options()[0]!.props["aria-selected"]).toBe(true);
    // Typing on is another list: nothing in it is lit until the arrows say so.
    await type("/con");
    expect(options().some((o) => o.props["aria-selected"])).toBe(false);
    expect(key("Enter").preventDefault).not.toHaveBeenCalled();
    key("ArrowDown");
    await act(async () => { key("Enter"); });
    expect(textarea().props.value).toBe("/context ");

    await type("/co");
    key("ArrowDown");
    await act(async () => { key("Enter"); });
    expect(textarea().props.value).toBe("/compact ");

    await type("/m");
    expect(options().length).toBeGreaterThan(0);
    key("Escape");
    expect(options()).toHaveLength(0);
    await type("/mo");
    expect(options().length).toBeGreaterThan(0);
  });

  test("a computer that lists commands adds the person's own; one that cannot is never asked", async () => {
    const old = await open();
    await type("/");
    expect(old.paneCommands).not.toHaveBeenCalled();
    await act(async () => view!.unmount());

    const paneCommands = mock(async () => ({ commands: [
      { name: "compact", description: "Clear conversation history but keep a summary in context", source: "builtin" },
      { name: "standup", description: "Write my standup", source: "user" },
    ] }));
    const { paneId } = await open({ capabilities: ["sessions", "commands"], paneCommands });
    await type("/");
    expect(paneCommands).toHaveBeenCalledWith(paneId);
    const standup = options().find((o) => textOf(o).includes("/standup"))!;
    expect(textOf(standup)).toContain("personal");
    expect(textOf(standup)).toContain("Write my standup");
  });

  test("a shell gets no picker: a slash there is the terminal's", async () => {
    await open({ pane: { isAgent: false, agent: null, status: "unknown" } });
    await type("/");
    expect(options()).toHaveLength(0);
  });
});

describe("quick replies", () => {
  test("an idle agent with a conversation offers the replies and /, and a reply is sent the moment it is tapped", async () => {
    const { send, paneId } = await open();
    expect(chips()).toHaveLength(1);
    for (const label of ["Commands", "Continue", "Yes, go ahead", "Explain that more simply", "Summarize what you changed"]) expect(chip(label)).toBeTruthy();
    await act(async () => chip("Continue").props.onClick());
    expect(send).toHaveBeenCalledWith(paneId, "Continue", expect.any(String), "i1");
    expect(textarea().props.value).toBe("");
  });

  test("after a send the chips stay away while the agent still looks idle, and return once it has worked", async () => {
    const { update } = await open();
    await act(async () => chip("Yes, go ahead").props.onClick());
    expect(chips()).toHaveLength(0);
    await update({ status: "working" });
    expect(chips()).toHaveLength(0);
    await update({ status: "idle" });
    expect(chips()).toHaveLength(1);
  });

  test("a reply whose delivery is uncertain lands in the composer, and Send retries it under the same id", async () => {
    const send = mock().mockRejectedValueOnce(new Error("connection interrupted")).mockResolvedValue({ accepted: true });
    await open({ send });
    await act(async () => chip("Continue").props.onClick());
    expect(textarea().props.value).toBe("Continue");
    expect(JSON.stringify(view!.toJSON())).toContain("Delivery not confirmed");
    await act(async () => view!.root.findAllByType("button").find((b) => b.props.className === "compose__send")!.props.onClick());
    expect(send.mock.calls[1]![2]).toBe(send.mock.calls[0]![2]);
  });

  test("a typed draft is never replaced or discarded by a chip: the chips go while it is there", async () => {
    await open();
    await type("only the parser tests");
    expect(chips()).toHaveLength(0);
    expect(textarea().props.value).toBe("only the parser tests");
    await type("");
    expect(chips()).toHaveLength(1);
  });

  test("the / chip starts a command in the reply box", async () => {
    const { send } = await open();
    await act(async () => chip("Commands").props.onClick());
    expect(textarea().props.value).toBe("/");
    expect(options().length).toBeGreaterThan(0);
    expect(send).not.toHaveBeenCalled();
  });

  test("nothing is offered while the agent works or asks a choice, or to a shell", async () => {
    for (const pane of [{ status: "working" }, { status: "blocked", hasPrompt: true }, { status: "idle", hasPrompt: true }, { isAgent: false, agent: null }]) {
      await open({ pane });
      expect(chips()).toHaveLength(0);
      await act(async () => view!.unmount());
    }
  });

  test("a new agent with nothing said yet is offered only /", async () => {
    await open({ pane: { lastMessageAt: null } });
    expect(chip("Commands")).toBeTruthy();
    expect(view!.root.findAll((n) => n.type === "button" && textOf(n) === "Continue")).toHaveLength(0);
  });
});
