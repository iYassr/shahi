/**
 * Links to paths the app has no screen for.
 *
 * expo-router's own router runs here with the app's real `+not-found` and
 * `+native-intent` routes; the other screens are stand-ins. The router reads
 * its generated-route options from `Constants.expoConfig.extra.router`, which
 * the expo-router config plugin fills from app.json's plugin options, so that
 * is where they come from here too.
 */
import { Text } from "react-native";
import { renderRouter, screen, act } from "expo-router/testing-library";

jest.mock("expo-constants", () => {
  const actual = jest.requireActual("expo-constants");
  const { expo } = jest.requireActual("../../app.json") as { expo: { plugins: unknown[] } };
  const plugin = expo.plugins.find((p) => p === "expo-router" || (Array.isArray(p) && p[0] === "expo-router"));
  const options = Array.isArray(plugin) ? plugin[1] : {};
  const constants = actual.default ?? actual;
  const expoConfig = { ...constants.expoConfig, extra: { ...constants.expoConfig?.extra, router: options } };
  return { ...actual, __esModule: true, default: { ...constants, expoConfig } };
});

const routes = () => ({
  _layout: require("expo-router/stack").Stack,
  index: () => <Text>Agents</Text>,
  connect: () => <Text>Connect</Text>,
  "+not-found": require("../app/+not-found").default,
  "+native-intent": require("../app/+native-intent"),
});

// Seen on a Release build: shahi://nowhere/at/all opened expo-router's
// developer "Unmatched Route" page, and its Sitemap link — or
// shahi://_sitemap directly — crashed the app on window.location.origin.
test.each(["/nowhere/at/all", "/_sitemap", "/pair"])("an unknown link %s never shows the developer page and lands on the app", async (path) => {
  const view = renderRouter(routes(), { initialUrl: path });
  await act(async () => {});
  expect(screen.queryByText(/Unmatched Route/)).toBeNull();
  expect(screen.queryByText(/Sitemap/)).toBeNull();
  expect(screen.getByText("Agents")).toBeTruthy();
  expect(view.getPathname()).toBe("/");
});

test("an unknown link while the app is open goes back to where it was", async () => {
  const view = renderRouter(routes(), { initialUrl: "/connect" });
  await act(async () => {});
  const { router } = require("expo-router") as typeof import("expo-router");
  act(() => router.push("/nowhere/at/all" as never));
  await act(async () => {});
  expect(screen.getByText("Connect")).toBeTruthy();
  expect(view.getPathname()).toBe("/connect");
});
