/**
 * What a test environment cannot have.
 *
 * These are the modules that reach the device. Faking them is not a shortcut —
 * a component test's job is the component, and a real `expo-haptics` here would
 * only assert that a Linux box has no Taptic Engine.
 */
jest.mock("expo-haptics", () => ({
  impactAsync: jest.fn(),
  notificationAsync: jest.fn(),
  ImpactFeedbackStyle: { Light: "light" },
  NotificationFeedbackType: { Success: "success", Error: "error" },
}));

// The relay's ephemeral keys want the platform's CSPRNG; here that is Node's.
jest.mock("expo-crypto", () => ({
  getRandomBytes: (n: number) => new Uint8Array(require("node:crypto").randomBytes(n)),
}));

jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

/*
 * `fetch` is faked per test, not here.
 *
 * Expo's winter runtime installs it as a lazy global behind a Proxy, and
 * assigning to it at setup time makes that Proxy require a module before the
 * test scope exists — which fails every suite with "trying to require a file
 * outside of the scope of the test code" and no mention of fetch at all.
 */
