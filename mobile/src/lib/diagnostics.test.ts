import * as Sentry from "@sentry/react-native";

const mockNative = { enabled: false, isEnabled: () => mockNative.enabled, setEnabled: (value: boolean) => { mockNative.enabled = value; } };
jest.mock("expo", () => ({ requireOptionalNativeModule: () => mockNative }));
const dev = __DEV__;
afterEach(() => { Object.defineProperty(globalThis, "__DEV__", { configurable: true, value: dev }); });

function start(enabled: boolean) {
  Object.defineProperty(globalThis, "__DEV__", { configurable: true, value: false });
  mockNative.enabled = enabled;
  let options: Record<string, any> | undefined;
  const client = { getOptions: () => options };
  (Sentry.init as jest.Mock).mockClear().mockImplementation(value => { options = value; });
  (Sentry.getClient as jest.Mock).mockImplementation(() => options ? client : undefined);
  let diagnostics!: typeof import("./diagnostics");
  jest.isolateModules(() => { diagnostics = require("./diagnostics"); });
  return { diagnostics, options: () => options! };
}

test("a saved opt-out initializes no SDK; enabling starts it once and subsequent toggles keep its integrations", () => {
  const { diagnostics, options } = start(false);
  diagnostics.initializeDiagnostics();
  expect(Sentry.init).not.toHaveBeenCalled();
  diagnostics.setDiagnosticsEnabled(true);
  expect(Sentry.init).toHaveBeenCalledTimes(1);
  expect(options().enabled).toBe(true);
  diagnostics.setDiagnosticsEnabled(false);
  expect(options().enabled).toBe(false);
  diagnostics.setDiagnosticsEnabled(true);
  expect(Sentry.init).toHaveBeenCalledTimes(1);
  expect(options().enabled).toBe(true);
});

test("the SDK callback checks the current native preference and strips raw error content", () => {
  const { diagnostics, options } = start(true);
  diagnostics.initializeDiagnostics();
  const event = { exception: { values: [{ type: "TypeError", value: "PRIVATE-CANARY" }] }, request: { url: "PRIVATE-CANARY" } };
  expect(JSON.stringify(options().beforeSend(event))).not.toContain("PRIVATE-CANARY");
  diagnostics.setDiagnosticsEnabled(false);
  expect(options().beforeSend(event)).toBeNull();
});
