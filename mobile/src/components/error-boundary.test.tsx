import { fireEvent, render } from "@testing-library/react-native";
import { Text } from "react-native";
import { ErrorBoundary } from "./error-boundary";

/**
 * The boundary between a crash and a white screen.
 *
 * "Had to refresh the page" is the symptom the whole app is trying to shed,
 * and an uncaught render error is its worst cause: the tree unmounts and
 * nothing says why. This proves the boundary catches, names the error, and
 * that Reload actually remounts — a boundary that catches but cannot recover
 * just moves the dead end one screen later.
 */

// A child whose crash is controlled from outside, the way a transient bad
// state (a half-written snapshot, say) crashes once and then is gone.
let broken = true;
function Fickle() {
  if (broken) throw new Error("kaboom from render");
  return <Text>the app, alive</Text>;
}

describe("ErrorBoundary", () => {
  // React logs every caught render error to console.error; that noise is the
  // boundary working, not a failure to silence.
  let consoleError: jest.SpyInstance;
  beforeEach(() => {
    broken = true;
    consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => consoleError.mockRestore());

  test("shows healthy children untouched", () => {
    broken = false;
    const view = render(
      <ErrorBoundary>
        <Fickle />
      </ErrorBoundary>,
    );
    expect(view.getByText("the app, alive")).toBeTruthy();
    expect(view.queryByText("Something broke.")).toBeNull();
  });

  test("a render crash becomes a screen that names the error", () => {
    const view = render(
      <ErrorBoundary>
        <Fickle />
      </ErrorBoundary>,
    );
    expect(view.getByText("Something broke.")).toBeTruthy();
    expect(view.getByText(/kaboom from render/)).toBeTruthy();
  });

  test("Reload remounts the tree, and a cleared fault stays cleared", () => {
    const view = render(
      <ErrorBoundary>
        <Fickle />
      </ErrorBoundary>,
    );
    expect(view.getByText("Something broke.")).toBeTruthy();

    broken = false;
    fireEvent.press(view.getByText("Reload"));
    expect(view.getByText("the app, alive")).toBeTruthy();
    expect(view.queryByText("Something broke.")).toBeNull();
  });

  test("a fault that persists is caught again rather than escaping", () => {
    const view = render(
      <ErrorBoundary>
        <Fickle />
      </ErrorBoundary>,
    );
    fireEvent.press(view.getByText("Reload"));
    expect(view.getByText("Something broke.")).toBeTruthy();
  });
});
