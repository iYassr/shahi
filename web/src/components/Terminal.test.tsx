import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

/*
 * xterm.js needs a real DOM; what matters here is what the component asks of
 * it, so a stand-in records the screen each terminal instance was given. Like
 * xterm, it queues writes and resets at once, so a reset between two queued
 * writes of the same frame does not stop both from printing.
 */
class FakeXterm {
  static made: FakeXterm[] = [];
  cols: number;
  rows: number;
  shown = "";
  queued: string[] = [];
  disposed = false;
  keys: ((event: { key: string }) => boolean) | undefined;
  /** xterm's hidden input, which it creates in `open`. */
  textarea = { tabIndex: 0, attributes: {} as Record<string, string>, setAttribute(name: string, value: string) { this.attributes[name] = value; } };
  constructor(options: { cols: number; rows: number }) { this.cols = options.cols; this.rows = options.rows; FakeXterm.made.push(this); }
  attachCustomKeyEventHandler(handler: (event: { key: string }) => boolean) { this.keys = handler; }
  open() {}
  dispose() { this.disposed = true; }
  reset() { this.shown = ""; }
  write(data: string) { this.queued.push(data); }
  resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; }
  /** xterm's parser catching up, which happens between React commits. */
  static process() { for (const term of FakeXterm.made) term.shown += term.queued.splice(0).join(""); }
  get screen() { return this.shown; }
}
mock.module("@xterm/xterm", () => ({ Terminal: FakeXterm }));
mock.module("@xterm/xterm/css/xterm.css", () => ({}));
const { Terminal } = await import("./Terminal");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let view: ReactTestRenderer | undefined;
const originals = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
  FakeXterm.made = [];
  for (const [key, value] of Object.entries({
    document: { documentElement: {} },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
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
const host = { createNodeMock: () => ({}) };
const showing = () => FakeXterm.made.filter(term => !term.disposed);

test("the screen stays painted when the pane's real size arrives after its first frame", async () => {
  // PaneView draws at 146×42 until the pane's layout arrives. An idle shell
  // or a blocked agent sends no new frame, so a terminal rebuilt for the real
  // size without the current screen stayed blank.
  await act(async () => { view = create(<Terminal ansi="$ ready" text="$ ready" cols={146} rows={42} scale={1} />, host); });
  FakeXterm.process();
  await act(async () => view!.update(<Terminal ansi="$ ready" text="$ ready" cols={120} rows={36} scale={1} />));
  FakeXterm.process();
  expect(showing()).toHaveLength(1);
  expect(showing()[0]).toMatchObject({ cols: 120, rows: 36, screen: "$ ready" });
});

test("a new frame and a new size together print the frame once", async () => {
  await act(async () => { view = create(<Terminal ansi="first" text="first" cols={146} rows={42} scale={1} />, host); });
  FakeXterm.process();
  await act(async () => view!.update(<Terminal ansi="second" text="second" cols={120} rows={36} scale={1} />));
  FakeXterm.process();
  expect(showing()).toHaveLength(1);
  expect(showing()[0]).toMatchObject({ cols: 120, rows: 36, screen: "second" });
});

test("the terminal hands Tab, Shift+Tab and Escape back to the page", async () => {
  // Its hidden input kept focus and turned these keys into terminal input,
  // so a keyboard could not leave the Screen tab or close focus view.
  await act(async () => { view = create(<Terminal ansi="$ ready" text="$ ready" cols={146} rows={42} scale={1} />, host); });
  const [term] = showing();
  expect(term!.keys).toBeDefined();
  for (const key of ["Tab", "Escape", "a"]) expect(term!.keys!({ key })).toBe(false);
  expect(term!.textarea.tabIndex).toBe(-1);
  expect(term!.textarea.attributes["aria-hidden"]).toBe("true");
});

test("the screen's words reach assistive technology", async () => {
  // Drawn as a labelled image, the screen had no text a screen reader could read.
  await act(async () => { view = create(<Terminal ansi={"\x1b[1m$ bun test\x1b[0m"} text="$ bun test" cols={146} rows={42} scale={1} />, host); });
  const region = view!.root.findByProps({ "aria-label": "Terminal output" });
  expect(region.props.role).toBe("region");
  expect(region.findByType("pre").children.join("")).toBe("$ bun test");
});
