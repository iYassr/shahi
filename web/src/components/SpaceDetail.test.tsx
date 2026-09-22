import { afterEach, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { Session } from "../api";
import { SpaceDetail } from "./Spaces";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let view: ReactTestRenderer | undefined;
afterEach(async () => { if (view) await act(async () => view!.unmount()); view = undefined; });

async function render(session: Session | null) {
  await act(async () => {
    view = create(
      <MemoryRouter initialEntries={["/space/w9"]}>
        <Routes>
          <Route path="/spaces" element={<p>Spaces list</p>} />
          <Route path="/space/:workspaceId" element={<SpaceDetail session={session} onToast={mock()} onChanged={mock()} />} />
        </Routes>
      </MemoryRouter>,
    );
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
