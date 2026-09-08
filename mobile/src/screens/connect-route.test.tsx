import { render } from "@testing-library/react-native";
import { router } from "expo-router";
import ConnectRoute from "../app/connect";
const mockState = { ready: true, connected: false, addingComputer: false, computers: [{ id: "saved" }], signInSsh: jest.fn(), signInRelay: jest.fn() };
jest.mock("@/lib/session", () => ({ useSession: () => mockState }));
jest.mock("@/screens/connect", () => ({ Connect: () => null }));
jest.mock("expo-router", () => ({ router: { replace: jest.fn(), push: jest.fn() } }));
beforeEach(() => { jest.clearAllMocks(); mockState.addingComputer = false; });
test("lost access opens saved computers instead of onboarding", () => {
  render(<ConnectRoute />);
  expect(router.replace).toHaveBeenCalledWith("/computers");
});
test("explicit Add a computer keeps the pairing form available", () => {
  mockState.addingComputer = true;
  render(<ConnectRoute />);
  expect(router.replace).not.toHaveBeenCalled();
});
