import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";
import { UnreachableError } from "@shahi/shared/errors";
import { ConnectionHealth } from "./ConnectionHealth";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let view: ReactTestRenderer | undefined;
const originals = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
  jest.useFakeTimers();
  for (const [key, value] of Object.entries({ navigator: { onLine: true }, window: new EventTarget() })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
});
afterEach(async () => {
  if (view) await act(async () => view!.unmount());
  view = undefined;
  jest.useRealTimers();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key];
  }
});
const tree = (link: "live" | "lost", error: Error | null) =>
  <MemoryRouter><ConnectionHealth link={link} error={error} relay={false} onRetry={async () => {}} /></MemoryRouter>;
const text = () => JSON.stringify(view!.toJSON());

// The phone's finding, kept the same on the web: a live link that drops for a
// moment showed the full disconnected notice over a computer that came back
// by itself (build 28, October 2026).
test("a live link that drops shows one quiet line, and the full notice only after the grace", async () => {
  await act(async () => { view = create(tree("live", null)); });
  await act(async () => view!.update(tree("lost", new UnreachableError("box", "relay", "offline"))));
  expect(text()).toContain("Reconnecting to your computer…");
  expect(text()).not.toContain("Computer disconnected");
  expect(text()).not.toContain("Retry connection");
  await act(async () => { jest.advanceTimersByTime(7_000); });
  expect(text()).toContain("Computer disconnected");
  expect(text()).toContain("Retry connection");
});

test("a page opened on a computer already gone shows the full notice at once", async () => {
  await act(async () => { view = create(tree("lost", new UnreachableError("box", "relay", "offline"))); });
  expect(text()).toContain("Computer disconnected");
});
