/**
 * Push, up to the edge of the device.
 *
 * The one thing this cannot prove is a notification arriving — that needs a
 * real iPhone (see docs/notifications.md). What it can prove is every refusal
 * saying why, the token reaching the server when everything holds, and a tap
 * landing on the pane it names — including the cold-launch tap that arrives
 * before any listener exists, which is the easy one to lose.
 */

jest.mock("expo-device", () => ({ isDevice: true }));

jest.mock("expo-constants", () => ({
  __esModule: true,
  default: {
    executionEnvironment: "standalone",
    expoConfig: { extra: { eas: { projectId: "proj-1" } } },
  },
  ExecutionEnvironment: { Bare: "bare", Standalone: "standalone", StoreClient: "storeClient" },
}));

jest.mock("expo-notifications", () => ({
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(async () => null),
  getPermissionsAsync: jest.fn(async () => ({ granted: true })),
  requestPermissionsAsync: jest.fn(async () => ({ granted: false })),
  getExpoPushTokenAsync: jest.fn(async () => ({ data: "ExponentPushToken[abc]" })),
  getLastNotificationResponseAsync: jest.fn(async () => null),
  clearLastNotificationResponseAsync: jest.fn(async () => undefined),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  AndroidImportance: { HIGH: 4 },
}));

jest.mock("@/lib/api", () => ({
  api: { registerPush: jest.fn(async () => ({ ok: true })) },
}));

type Push = typeof import("./push");

// `canLoad` is decided as the module evaluates, so each test loads a fresh
// copy after arranging the device and build it should believe it is on.
function load(arrange: (mods: {
  Device: { isDevice: boolean };
  Constants: { executionEnvironment: string; expoConfig: { extra?: { eas?: { projectId?: string } } } | null };
  Notifications: Record<string, jest.Mock>;
  api: { registerPush: jest.Mock };
}) => void = () => {}): Push {
  jest.resetModules();
  const Device = require("expo-device");
  const Constants = require("expo-constants").default;
  const Notifications = require("expo-notifications");
  const { api } = require("@/lib/api");
  arrange({ Device, Constants, Notifications, api });
  return require("./push") as Push;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("enablePush", () => {
  test("a simulator is refused with the reason, before anything loads", async () => {
    const push = load(({ Device }) => {
      Device.isDevice = false;
    });
    const result = await push.enablePush();
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/real device/i) });
  });

  test("Expo Go is named as the problem, not crashed into", async () => {
    const push = load(({ Constants }) => {
      Constants.executionEnvironment = "storeClient";
    });
    const result = await push.enablePush();
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("Expo Go") });
  });

  test("a denied permission is reported as the setting it is", async () => {
    const push = load(({ Notifications }) => {
      Notifications.getPermissionsAsync!.mockResolvedValue({ granted: false });
    });
    const result = await push.enablePush();
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/turned off/i) });
  });

  test("permission granted on the ask, not just on the check, still proceeds", async () => {
    const push = load(({ Notifications }) => {
      Notifications.getPermissionsAsync!.mockResolvedValue({ granted: false });
      Notifications.requestPermissionsAsync!.mockResolvedValue({ granted: true });
    });
    const result = await push.enablePush();
    expect(result.ok).toBe(true);
  });

  test("a build with no EAS project id cannot mint a token, and says so", async () => {
    const push = load(({ Constants }) => {
      Constants.expoConfig = null;
    });
    const result = await push.enablePush();
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("project id") });
  });

  test("the happy path registers the token with the server and returns it", async () => {
    let registered: jest.Mock;
    const push = load(({ api }) => {
      registered = api.registerPush;
    });
    const result = await push.enablePush();
    expect(result).toEqual({ ok: true, token: "ExponentPushToken[abc]" });
    expect(registered!).toHaveBeenCalledWith("ExponentPushToken[abc]");
  });

  // The server registration is the point: a token the server never saw is a
  // toggle that lies. Its failure must come back as a refusal.
  test("a failed server registration is a refusal, not a success", async () => {
    const push = load(({ api }) => {
      api.registerPush.mockRejectedValue(new Error("passcode required"));
    });
    const result = await push.enablePush();
    expect(result).toEqual({ ok: false, reason: "passcode required" });
  });
});

describe("onNotificationTapped", () => {
  const response = (paneId: unknown) => ({
    notification: { request: { content: { data: { paneId } } } },
  });

  test("a tap that cold-launched the app still lands on its pane, then is cleared", async () => {
    let notifications: Record<string, jest.Mock>;
    const push = load(({ Notifications }) => {
      notifications = Notifications;
      Notifications.getLastNotificationResponseAsync!.mockResolvedValue(response("w4:p2"));
    });
    const open = jest.fn();
    push.onNotificationTapped(open);
    await flush();
    expect(open).toHaveBeenCalledWith("w4:p2");
    // Cleared so a later remount does not re-open the same pane on a stale tap.
    expect(notifications!.clearLastNotificationResponseAsync).toHaveBeenCalled();
  });

  test("a live tap routes to its pane; one without a paneId routes nowhere", async () => {
    let listener: (r: unknown) => void;
    const push = load(({ Notifications }) => {
      Notifications.addNotificationResponseReceivedListener!.mockImplementation((fn: (r: unknown) => void) => {
        listener = fn;
        return { remove: jest.fn() };
      });
    });
    const open = jest.fn();
    push.onNotificationTapped(open);
    await flush();

    listener!(response("w1:p1"));
    expect(open).toHaveBeenCalledWith("w1:p1");

    open.mockClear();
    listener!(response(undefined));
    listener!(response(42));
    expect(open).not.toHaveBeenCalled();
  });

  test("cancelling before the module loads means no open, ever", async () => {
    let notifications: Record<string, jest.Mock>;
    const push = load(({ Notifications }) => {
      notifications = Notifications;
      Notifications.getLastNotificationResponseAsync!.mockResolvedValue(response("w4:p2"));
    });
    const open = jest.fn();
    const cancel = push.onNotificationTapped(open);
    cancel();
    await flush();
    expect(open).not.toHaveBeenCalled();
    expect(notifications!.addNotificationResponseReceivedListener).not.toHaveBeenCalled();
  });
});
