import { act, fireEvent, render, waitFor, within } from "@testing-library/react-native";
import { Dimensions } from "react-native";
import type { FileDiff, PaneChanges } from "@shahi/shared";
import { ApiError, UnauthorizedError } from "@/lib/api";
import { ChangesView } from "./changes-view";

/**
 * The phone's Changes view (October 2026): the owner asked to review what an
 * agent changed, as a diff, from the phone. What must hold: files are said in
 * words, a diff is numbered line by line and never wrapped, a folder outside
 * any repository is a calm sentence, and nothing is read on a timer.
 */
const mockSession = { api: {} as Record<string, jest.Mock>, unauthorized: jest.fn() };
jest.mock("@/lib/session", () => ({ useSession: () => mockSession }));
jest.mock("expo-router", () => ({ useFocusEffect: (effect: () => void) => require("react").useEffect(effect, [effect]) }));

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
  path: "src/cart.ts", status: "modified", omitted: 1_234,
  lines: ["@@ -4,2 +4,3 @@", " const total = 0;", "-return total;", "+const tax = 1;", "+return total + tax;"],
};

beforeEach(() => {
  mockSession.api = { changes: jest.fn().mockResolvedValue(listed), fileDiff: jest.fn().mockResolvedValue(cartDiff) };
  mockSession.unauthorized.mockReset();
});

test("lists each changed file in words a screen reader can say, and opens one's diff numbered line by line", async () => {
  const view = render(<ChangesView paneId="w1:p1" />);
  await waitFor(() => view.getByLabelText("src/cart.ts, modified, 2 lines added, 1 removed"));
  expect(view.getByText(/shop/)).toBeTruthy();
  expect(view.getByText(/main/)).toBeTruthy();
  expect(view.getByLabelText("logo.png, untracked")).toBeTruthy();

  fireEvent.press(view.getByLabelText("src/cart.ts, modified, 2 lines added, 1 removed"));
  await waitFor(() => view.getByLabelText("Removed, line 5: return total;"));
  expect(mockSession.api.fileDiff).toHaveBeenCalledWith("w1:p1", "src/cart.ts");
  expect(view.getByLabelText("Unchanged, line 4: const total = 0;")).toBeTruthy();
  expect(view.getByLabelText("Added, line 5: const tax = 1;")).toBeTruthy();
  expect(view.getByLabelText("Added, line 6: return total + tax;")).toBeTruthy();
  expect(view.getByText("… 1,234 more lines, too many to show here.")).toBeTruthy();
});

test("a diff scrolls sideways at its longest line's width rather than wrapping", async () => {
  const wide = `+${"x".repeat(300)}`;
  mockSession.api.fileDiff.mockResolvedValue({ ...cartDiff, lines: ["@@ -1 +1 @@", "-a", wide], omitted: 0 });
  const view = render(<ChangesView paneId="w1:p1" />);
  await waitFor(() => view.getByLabelText(/src\/cart.ts, modified/));
  fireEvent.press(view.getByLabelText(/src\/cart.ts, modified/));
  const list = await waitFor(() => view.getByTestId("diff-lines"));
  const width = [list.props.style].flat(3).find((style: { width?: number } | undefined) => style?.width)?.width as number;
  // Three hundred characters of 12-point Menlo and the gutter: far wider than a phone.
  expect(width).toBeGreaterThan(300 * 12 * 0.6);
});

// Jest's preset starts at a font scale of 2, already large text, so both
// sizes are set explicitly (see spaces-rows.test.tsx).
test.each([[1, 1], [3.12, undefined]])("a long path keeps its file name at font scale %s, and at large sizes is whole with its counts beneath", async (fontScale, lines) => {
  const window = Dimensions.get("window");
  const screen = Dimensions.get("screen");
  act(() => Dimensions.set({ window: { ...window, fontScale }, screen }));
  try {
    const path = "packages/storefront/src/features/checkout/components/CartSummary.tsx";
    mockSession.api.changes.mockResolvedValue({ repository, files: [{ path, status: "modified", added: 12, removed: 3 }], omitted: 0 });
    const view = render(<ChangesView paneId="w1:p1" />);
    await waitFor(() => view.getByLabelText(`${path}, modified, 12 lines added, 3 removed`));
    const name = view.getByText("CartSummary.tsx", { exact: false });
    expect(name.props.numberOfLines).toBe(lines);
    expect(name.props.ellipsizeMode).toBe("head");
    // Large: the counts share the path's column, under it, not its width.
    let column = name.parent;
    while (column && (column.type as unknown) !== "View") column = column.parent;
    expect(within(column!).queryByText("+12") !== null).toBe(fontScale > 1.4);
  } finally {
    act(() => Dimensions.set({ window, screen }));
  }
});

test("a folder outside any repository is a calm sentence, and a repository with nothing changed says so", async () => {
  mockSession.api.changes.mockResolvedValue({ repository: null, note: "This folder is not in a Git repository, so there are no changes to show.", files: [], omitted: 0 });
  const outside = render(<ChangesView paneId="w1:p1" />);
  await waitFor(() => outside.getByText("This folder is not in a Git repository, so there are no changes to show."));
  expect(outside.queryByRole("alert")).toBeNull();
  outside.unmount();

  mockSession.api.changes.mockResolvedValue({ repository, files: [], omitted: 0 });
  const clean = render(<ChangesView paneId="w1:p1" />);
  await waitFor(() => clean.getByText("No changes since the last commit."));
});

test("reads again when asked and when the agent finishes a turn, and not on a timer", async () => {
  jest.useFakeTimers();
  try {
    const view = render(<ChangesView paneId="w1:p1" status="working" />);
    await waitFor(() => view.getByLabelText(/src\/cart.ts/));
    expect(mockSession.api.changes).toHaveBeenCalledTimes(1);
    await act(async () => { jest.advanceTimersByTime(60_000); });
    expect(mockSession.api.changes).toHaveBeenCalledTimes(1);
    fireEvent.press(view.getByLabelText("Refresh changes"));
    await waitFor(() => expect(mockSession.api.changes).toHaveBeenCalledTimes(2));
    view.rerender(<ChangesView paneId="w1:p1" status="done" />);
    await waitFor(() => expect(mockSession.api.changes).toHaveBeenCalledTimes(3));
  } finally {
    jest.useRealTimers();
  }
});

test("a file whose changes are gone says so in the computer's words, and a refused session is handed back", async () => {
  mockSession.api.fileDiff.mockRejectedValue(new ApiError("That file has no changes any more. Refresh the list of changes.", 404, "not_changed"));
  const view = render(<ChangesView paneId="w1:p1" />);
  await waitFor(() => view.getByLabelText(/src\/cart.ts/));
  fireEvent.press(view.getByLabelText(/src\/cart.ts/));
  await waitFor(() => view.getByText("That file has no changes any more. Refresh the list of changes."));
  view.unmount();

  mockSession.api.changes.mockRejectedValue(new UnauthorizedError());
  render(<ChangesView paneId="w1:p1" />);
  await waitFor(() => expect(mockSession.unauthorized).toHaveBeenCalled());
});

test("a late answer from before the turn ended does not replace the newer one", async () => {
  let answerFirst: (value: PaneChanges) => void = () => {};
  mockSession.api.changes
    .mockImplementationOnce(() => new Promise((resolve) => { answerFirst = resolve; }))
    .mockResolvedValueOnce({ ...listed, files: [listed.files[0]!] });
  const view = render(<ChangesView paneId="w1:p1" status="working" />);
  view.rerender(<ChangesView paneId="w1:p1" status="done" />);
  await waitFor(() => view.getByLabelText(/src\/cart.ts/));
  await act(async () => answerFirst(listed));
  expect(view.queryByLabelText("logo.png, untracked")).toBeNull();
});
