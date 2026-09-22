import { afterEach, expect, test } from "bun:test";
import { useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Boundary } from "./Boundary";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let view: ReactTestRenderer | undefined;
afterEach(async () => { if (view) await act(async () => view!.unmount()); view = undefined; });

/**
 * Throws from an effect rather than from render: a render error in a concurrent
 * root is also reported through the global reportError, which the test runner
 * counts as a failure of its own. The boundary handles both the same way.
 */
function Broken() {
  useEffect(() => { throw new Error("drawing failed"); });
  return null;
}

test("back to agents after a render error stays inside the app instead of loading the site root", async () => {
  const loads: string[] = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
  // A page load would forget session-only computers and drafts, and "/" on the
  // hosted app is the marketing site. Record any attempt instead of making it.
  Object.defineProperty(globalThis, "location", { configurable: true, value: { set href(value: string) { loads.push(value); }, reload: () => loads.push("reload") } });
  const quiet = console.error;
  console.error = () => {};
  try {
    await act(async () => {
      view = create(
        <MemoryRouter initialEntries={["/pane/w1:p1"]}>
          <Boundary>
            <Routes>
              <Route path="/" element={<p>Agent list</p>} />
              <Route path="/pane/:paneId" element={<Broken />} />
            </Routes>
          </Boundary>
        </MemoryRouter>,
      );
    });
    // Past the one silent retry, to the screen a person sees.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
    const back = view!.root.findAllByType("button").find((button) => button.children.join("") === "Back to agents")!;
    await act(async () => back.props.onClick());
    expect(JSON.stringify(view!.toJSON())).toContain("Agent list");
    expect(loads).toEqual([]);
  } finally {
    console.error = quiet;
    if (previous) Object.defineProperty(globalThis, "location", previous);
    else Reflect.deleteProperty(globalThis, "location");
  }
});
