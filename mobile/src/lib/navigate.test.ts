import { router } from "expo-router";
import { openPane, openScreen } from "./navigate";

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));

/**
 * Pane ids contain a colon (`w4:p2`). Built as a template string that colon
 * needs hand-encoding, and getting it wrong opens a pane called `w4%3Ap2` or
 * nothing at all — so these lock down the object form, where the router owns
 * the encoding and the id goes down raw.
 */
describe("opening a pane", () => {
  beforeEach(() => (router.push as jest.Mock).mockReset());

  test("the id travels as a param, colon intact", () => {
    openPane("w4:p2");
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/pane/[paneId]",
      params: { paneId: "w4:p2" },
    });
  });

  test("the Screen action opens the same pane on the raw terminal", () => {
    openScreen("w4:p2");
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/pane/[paneId]",
      params: { paneId: "w4:p2", view: "screen" },
    });
  });
});
