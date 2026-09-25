import { afterEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useParams, type NavigateFunction } from "react-router-dom";
import { OwnedRoute } from "./OwnedRoute";

/*
 * herdr numbers panes the same way on every computer. The hosted app switched
 * computers — by a notification routed in place, or through Settings — and
 * Back then reopened the previous computer's `/pane/w1%3Ap1` against the new
 * one, where a reply went into that computer's pane (pre-release bug hunt).
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let view: ReactTestRenderer | undefined;
afterEach(async () => { if (view) await act(async () => view!.unmount()); view = undefined; });

let go: NavigateFunction;
let where = "";
/** Which pane was shown on which computer, in order. */
const shown: string[] = [];

function Probe({ computer }: { computer: string }) {
  const { paneId } = useParams();
  shown.push(`${paneId} on ${computer}`);
  return <p>{`Pane ${paneId} on ${computer}`}</p>;
}
function Harness({ computer }: { computer: string | null }) {
  go = useNavigate();
  where = useLocation().pathname;
  return <Routes>
    <Route path="/" element={<p>List</p>} />
    <Route path="/settings" element={<p>Settings</p>} />
    <Route path="/pane/:paneId" element={<OwnedRoute computer={computer}><Probe computer={computer ?? "local"} /></OwnedRoute>} />
  </Routes>;
}
async function render(computer: string | null, entry = "/") {
  shown.length = 0;
  await act(async () => { view = create(<MemoryRouter initialEntries={[entry]}><Harness computer={computer} /></MemoryRouter>); });
}
async function switchTo(computer: string) {
  await act(async () => view!.update(<MemoryRouter><Harness computer={computer} /></MemoryRouter>));
}

test("Back after switching computers never shows the previous computer's pane of the same id", async () => {
  await render("A");
  await act(async () => go("/pane/w1%3Ap1"));
  await act(async () => go("/settings"));
  await switchTo("B");
  await act(async () => go(-1));
  expect(shown).not.toContain("w1:p1 on B");
  expect(where).toBe("/");
});

test("a pane opened by a link or a reload is held to the computer it was first shown on", async () => {
  await render("A", "/pane/w1%3Ap3");
  expect(shown).toContain("w1:p3 on A");
  await act(async () => go("/settings"));
  await switchTo("B");
  await act(async () => go(-1));
  expect(shown).not.toContain("w1:p3 on B");
  expect(where).toBe("/");
});

test("the computer's own entries still work after going away and back", async () => {
  await render("A");
  await act(async () => go("/pane/w1%3Ap1"));
  await act(async () => go("/settings"));
  await act(async () => go(-1));
  expect(shown.at(-1)).toBe("w1:p1 on A");
  expect(where).toBe("/pane/w1%3Ap1");
});

test("the locally served app, with one computer, records and refuses nothing", async () => {
  await render(null, "/pane/w1%3Ap1");
  expect(shown).toContain("w1:p1 on local");
  expect(where).toBe("/pane/w1%3Ap1");
});
