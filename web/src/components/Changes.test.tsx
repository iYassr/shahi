/**
 * The browser's Changes view (October 2026): the owner asked to review what
 * an agent changed, as a diff, from the phone and the browser alike.
 */
import { afterEach, expect, mock, test } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { FileDiff, PaneChanges } from "@shahi/shared";
import { ApiContext, ApiError, api } from "../api";
import { Changes } from "./Changes";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let view: ReactTestRenderer | undefined;
afterEach(async () => {
  if (view) await act(async () => view!.unmount());
  view = undefined;
});

const repository = { name: "shop", path: "~/shop", branch: "main", commit: "abc1234" };
const listed: PaneChanges = {
  repository,
  files: [
    { path: "src/cart.ts", status: "modified", added: 2, removed: 1 },
    { path: "logo.png", status: "untracked", added: null, removed: null },
  ],
  omitted: 0,
};
const cartDiff: FileDiff = {
  path: "src/cart.ts", status: "modified",
  lines: ["@@ -4,2 +4,3 @@", " const total = 0;", "-return total;", "+const tax = 1;", "+return total + tax;"],
  omitted: 1_234,
};

async function render(scoped: Partial<typeof api>, status?: string) {
  const value = { ...api, ...scoped };
  await act(async () => { view = create(<ApiContext.Provider value={value}><Changes paneId="w1:p1" status={status} /></ApiContext.Provider>); });
  return (next?: string) => act(async () => view!.update(<ApiContext.Provider value={value}><Changes paneId="w1:p1" status={next} /></ApiContext.Provider>));
}
const text = () => JSON.stringify(view!.toJSON());
const button = (name: string | RegExp) => view!.root.findAll((node) => node.type === "button" && (typeof name === "string" ? node.props["aria-label"] === name || node.children.join("") === name : name.test(String(node.props["aria-label"] ?? node.children.join("")))))[0]!;
const press = (node: ReactTestInstance) => act(async () => node.props.onClick());

test("lists each changed file in words a screen reader can say, and opens one's diff numbered line by line", async () => {
  const fileDiff = mock(async () => cartDiff);
  await render({ changes: mock(async () => listed), fileDiff });
  expect(text()).toContain("shop");
  expect(text()).toContain("main");
  expect(button("src/cart.ts, modified, 2 lines added, 1 removed")).toBeTruthy();
  expect(button("logo.png, untracked")).toBeTruthy();

  await press(button("src/cart.ts, modified, 2 lines added, 1 removed"));
  expect(fileDiff).toHaveBeenCalledWith("w1:p1", "src/cart.ts");
  const rows = view!.root.findAll((node) => node.props.className === "diff__row");
  expect(rows.map((row) => [row.props["data-kind"], ...row.findAll((n) => n.props.className === "diff__num").map((n) => n.children.join(""))]))
    .toEqual([["hunk", "", ""], ["context", "4", "4"], ["removed", "5", ""], ["added", "", "5"], ["added", "", "6"]]);
  expect(text()).toContain("1,234");
  expect(text()).toContain("more lines");
});

test("a folder outside any repository is a calm sentence, and an empty repository says nothing changed", async () => {
  await render({ changes: mock(async (): Promise<PaneChanges> => ({ repository: null, note: "This folder is not in a Git repository, so there are no changes to show.", files: [], omitted: 0 })) });
  expect(text()).toContain("This folder is not in a Git repository");
  expect(view!.root.findAllByProps({ role: "alert" })).toHaveLength(0);
  await act(async () => view!.unmount());
  await render({ changes: mock(async (): Promise<PaneChanges> => ({ repository, files: [], omitted: 0 })) });
  expect(text()).toContain("No changes since the last commit.");
});

test("refreshes when asked and when the agent finishes a turn, but not on a timer", async () => {
  const changes = mock(async () => listed);
  const update = await render({ changes }, "working");
  expect(changes).toHaveBeenCalledTimes(1);
  await press(button("Refresh"));
  expect(changes).toHaveBeenCalledTimes(2);
  await update("working");
  expect(changes).toHaveBeenCalledTimes(2);
  await update("done");
  expect(changes).toHaveBeenCalledTimes(3);
});

test("a file whose changes are gone says so in the computer's words", async () => {
  await render({
    changes: mock(async () => listed),
    fileDiff: mock(async () => { throw new ApiError("That file has no changes any more. Refresh the list of changes.", 404, "not_changed"); }),
  });
  await press(button("src/cart.ts, modified, 2 lines added, 1 removed"));
  expect(view!.root.findByProps({ role: "alert" }).children.join("")).toBe("That file has no changes any more. Refresh the list of changes.");
});

test("a binary file shows the computer's note instead of lines", async () => {
  await render({
    changes: mock(async () => listed),
    fileDiff: mock(async (): Promise<FileDiff> => ({ path: "logo.png", status: "untracked", lines: [], omitted: 0, note: "This is a binary file, so there are no lines to show." })),
  });
  await press(button("logo.png, untracked"));
  expect(text()).toContain("This is a binary file");
  expect(view!.root.findAll((node) => node.props.className === "diff")).toHaveLength(0);
});
