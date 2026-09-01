import { act, fireEvent, render } from "@testing-library/react-native";
import { Unreachable } from "./unreachable";

/**
 * The screen a person sees when their server cannot be read. What matters is
 * that it names the server, says why in plain words, and that both ways out
 * work — including the retry staying busy for as long as the attempt takes,
 * because a 15-second timeout with a button that looks idle invites five taps.
 */
describe("the unreachable screen", () => {
  const draw = (over: Partial<Parameters<typeof Unreachable>[0]> = {}) => {
    const onRetry = jest.fn(async () => {});
    const onSwitch = jest.fn();
    const view = render(
      <Unreachable
        title="Can't reach your server"
        message="Couldn't find ubuntu.tailnet.ts.net:7171. Check the address."
        server="http://ubuntu.tailnet.ts.net:7171"
        onRetry={onRetry}
        onSwitch={onSwitch}
        {...over}
      />,
    );
    return { view, onRetry, onSwitch };
  };

  test("names the server, without the scheme, and says why", () => {
    const { view } = draw();
    expect(view.getByText("Can't reach your server")).toBeTruthy();
    expect(view.getByText("ubuntu.tailnet.ts.net:7171")).toBeTruthy();
    expect(view.getByText(/Couldn't find ubuntu\.tailnet\.ts\.net:7171/)).toBeTruthy();
  });

  test("try again stays busy until the attempt settles", async () => {
    let settle!: () => void;
    const onRetry = jest.fn(() => new Promise<void>((resolve) => (settle = resolve)));
    const { view } = draw({ onRetry });

    fireEvent.press(view.getByTestId("retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(view.getByText("Trying…")).toBeTruthy();

    // A second tap while busy must not fire a second attempt.
    fireEvent.press(view.getByTestId("retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);

    await act(async () => settle());
    expect(view.getByText("Try again")).toBeTruthy();
  });

  test("a retry that fails still releases the button", async () => {
    const onRetry = jest.fn(async () => {
      throw new Error("still down");
    });
    const { view } = draw({ onRetry });
    await act(async () => {
      fireEvent.press(view.getByTestId("retry"));
    });
    expect(view.getByText("Try again")).toBeTruthy();
  });

  test("switch server is the way out", () => {
    const { view, onSwitch } = draw();
    fireEvent.press(view.getByTestId("switch-server"));
    expect(onSwitch).toHaveBeenCalledTimes(1);
  });
});
