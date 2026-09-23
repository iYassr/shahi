/**
 * The open-source notices are the app's, not a connected computer's: they
 * travel with every copy, and the licenses screen used to be reachable only
 * from Settings, inside the tabs a person reaches after connecting
 * (September 2026 review, F27).
 */
import { fireEvent, render, screen } from "@testing-library/react-native";
import { router } from "expo-router";
import { Connect } from "./connect";

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("@/components/scanner", () => ({ Scanner: () => null }));
jest.mock("@/components/icons", () => ({ Logo: () => null, Wordmark: () => null }));
jest.mock("@/components/greeting-logo", () => ({ GreetingLogo: () => null }));
jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn() }));
jest.mock("expo-device", () => ({ deviceName: null, modelName: "iPhone" }));

beforeEach(() => jest.clearAllMocks());

test("someone who has never connected a computer can open the licenses from the first screen", () => {
  render(<Connect onConnectedSsh={jest.fn()} onConnectedRelay={jest.fn()} />);
  fireEvent.press(screen.getByTestId("licenses-link"));
  expect(router.push).toHaveBeenCalledWith("/licenses");
});

test("the licenses stay one tap away on the SSH form", () => {
  render(<Connect onConnectedSsh={jest.fn()} onConnectedRelay={jest.fn()} />);
  fireEvent.press(screen.getByTestId("use-ssh"));
  fireEvent.press(screen.getByTestId("licenses-link"));
  expect(router.push).toHaveBeenCalledWith("/licenses");
});
