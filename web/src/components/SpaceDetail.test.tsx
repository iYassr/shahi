import { afterEach, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ApiContext, api, type Session } from "../api";
import { SpaceDetail } from "./Spaces";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let view: ReactTestRenderer | undefined;
afterEach(async () => { if (view) await act(async () => view!.unmount()); view = undefined; });

const tree = (session: Session | null) => (
  <ApiContext.Provider value={{ ...api, agents: mock().mockResolvedValue({ agents: [] }) }}>
    <MemoryRouter initialEntries={["/space/w9"]}>
      <Routes>
        <Route path="/spaces" element={<p>Spaces list</p>} />
        <Route path="/space/:workspaceId" element={<SpaceDetail session={session} onToast={mock()} onChanged={mock()} />} />
      </Routes>
    </MemoryRouter>
  </ApiContext.Provider>
);

async function render(session: Session | null) {
  await act(async () => {
    view = create(tree(session));
  });
}
const output = () => JSON.stringify(view!.toJSON());
const button = (label: string) => view!.root.findAll((node) => node.type === "button" && (node.props["aria-label"] === label || node.children.join("") === label))[0];

test("a space that closed while open still has a way back to spaces", async () => {
  await render({ workspaces: [], tabs: [], panes: [] } as unknown as Session);
  expect(output()).toContain("That space is gone");
  await act(async () => button("Back to spaces")!.props.onClick());
  expect(output()).toContain("Spaces list");
});

test("a space opened before the session arrives shows its header and back control, not a blank page", async () => {
  await render(null);
  expect(output()).toContain("Opening the space");
  await act(async () => button("Back")!.props.onClick());
  expect(output()).toContain("Spaces list");
});

// Pre-release bug hunt, B43: herdr gives a closed space's id to the next one
// after a restart, and a New agent sheet left open reopened by itself for it.
test("a New agent sheet for a space that closed does not reopen for the next space with its id", async () => {
  const space = (label: string) => ({
    workspaces: [{ workspaceId: "w9", label, status: "idle", paneCount: 1, tabCount: 1, focused: false, cwd: `~/${label}`, cwdPath: `/home/me/${label}` }],
    tabs: [],
    panes: [],
  }) as unknown as Session;
  await render(space("projA"));
  await act(async () => button("+ New agent")!.props.onClick());
  expect(output()).toContain("New agent in projA");
  await act(async () => view!.update(tree({ workspaces: [], tabs: [], panes: [] } as unknown as Session)));
  await act(async () => view!.update(tree(space("projB"))));
  expect(output()).not.toContain("New agent in");
});
