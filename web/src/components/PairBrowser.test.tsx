import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { toBase64Url } from "@shahi/shared/relay-client";
import { PairBrowser } from "./PairBrowser";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const server = toBase64Url(new Uint8Array(32).fill(9));
const secret = toBase64Url(new Uint8Array(32).fill(8));
const linkedCode = `shahi://pair#v=1&server=${server}&relay=${encodeURIComponent("https://relay.stranger.example")}&secret=${secret}`;

let view: ReactTestRenderer | undefined;
const originals = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
  for (const [key, value] of Object.entries({
    window: Object.assign(new EventTarget(), { matchMedia: () => ({ matches: false }) }),
    location: { hostname: "getshahi.dev" },
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
});
afterEach(async () => {
  if (view) await act(async () => view!.unmount());
  view = undefined;
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key];
  }
});
const text = () => JSON.stringify(view!.toJSON());
const buttons = () => view!.root.findAllByType("button").map(button => button.children.join(""));
const render = (initialCode: string, onConsumed = mock()) => act(async () => {
  view = create(<PairBrowser initialCode={initialCode} onConsumed={onConsumed} onSuccess={mock()} />);
});

test("a pairing link asks before connecting and names the relay and computer it points at", async () => {
  // A #pair= link can come from anyone. It opened onto a filled-in form whose
  // Connect button attached this browser to the sender's computer.
  await render(linkedCode);
  expect(text()).toContain("A link is asking to connect this browser");
  expect(text()).toContain("relay.stranger.example");
  expect(text()).toContain(`${server.slice(0, 16)}…`);
  expect(buttons()).toContain("Connect to relay.stranger.example");
  expect(buttons()).not.toContain("Connect");
  expect(view!.root.findAll(node => node.props.id === "pairing-code")).toHaveLength(0);
});

test("cancelling a pairing link discards its code", async () => {
  const onConsumed = mock();
  await render(linkedCode, onConsumed);
  await act(async () => view!.root.findAllByType("button").find(button => button.children.join("") === "Cancel")!.props.onClick());
  expect(onConsumed).toHaveBeenCalled();
  expect(text()).not.toContain("A link is asking");
  expect(view!.root.findByProps({ id: "pairing-code" }).props.value).toBe("");
});

test("a malformed pairing link says why and offers only Cancel", async () => {
  await render("shahi://pair#v=1&server=nonsense");
  expect(text()).toContain("A link is asking");
  expect(text()).toContain("Paste a complete Shahi pairing code");
  expect(buttons().filter(label => label.startsWith("Connect"))).toEqual([]);
  expect(buttons()).toContain("Cancel");
});

test("a code the person enters themselves needs no link warning", async () => {
  await render("");
  expect(text()).not.toContain("A link is asking");
  expect(buttons()).toContain("Connect");
});
