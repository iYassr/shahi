/**
 * Push, up to the edge of the device.
 *
 * The one thing this cannot prove is a notification arriving — that needs a
 * real iPhone (see docs/notifications.md). What it can prove is every refusal
 * saying why, the token reaching the server when everything holds, and a tap
 * landing on the pane it names — including the cold-launch tap that arrives
 * before any listener exists, which is the easy one to lose.
 */

import { Buffer } from "buffer";

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

// Pre-release bug hunt: the handler that tells iOS to show a notification
// arriving with the app open was set only by enablePush, which runs when the
// Settings row is tapped. After a relaunch there was none, and expo-notifications
// then answers iOS with "show nothing".
describe("showNotificationsWhileOpen", () => {
  test("a notification that arrives while the app is open is shown, without Settings ever running", async () => {
    let notifications!: Record<string, jest.Mock>;
    const push = load(({ Notifications }) => { notifications = Notifications; });
    push.showNotificationsWhileOpen();
    await flush();
    expect(notifications.setNotificationHandler).toHaveBeenCalledTimes(1);
    const [{ handleNotification }] = notifications.setNotificationHandler.mock.calls[0]!;
    await expect(handleNotification()).resolves.toEqual(expect.objectContaining({ shouldShowBanner: true, shouldShowList: true }));
    // Showing is not asking: nobody is prompted for permission at launch.
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  test("in Expo Go it stays quiet rather than loading a module that throws", async () => {
    let notifications!: Record<string, jest.Mock>;
    const push = load(({ Constants, Notifications }) => {
      Constants.executionEnvironment = "storeClient";
      notifications = Notifications;
    });
    push.showNotificationsWhileOpen();
    await flush();
    expect(notifications.setNotificationHandler).not.toHaveBeenCalled();
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

test("notification taps carry the computer identity along with the pane", async () => {
  const push = load();
  const notifications = require("expo-notifications");
  const open = jest.fn();
  notifications.getLastNotificationResponseAsync.mockResolvedValue({ notification: { request: { content: { data: { paneId: "p1", serverId: "computer-a" } } } } });
  const cancel = push.onNotificationTapped(open);
  await flush();
  expect(open).toHaveBeenCalledWith("p1", "computer-a");
  cancel();
});

test("a delayed permission prompt registers only with the computer that opened it", async () => {
  let release!: (value: { granted: boolean }) => void;
  const push = load(({ Notifications }) => {
    Notifications.getPermissionsAsync!.mockReturnValue(new Promise(r => { release = r; }));
  });
  const client = { registerPush: jest.fn(async () => {}) };
  const result = push.enablePush(client as never);
  await flush();
  release({ granted: true });
  await result;
  expect(client.registerPush).toHaveBeenCalledWith("ExponentPushToken[abc]");
  expect(require("@/lib/api").api.registerPush).not.toHaveBeenCalled();
});

// herdr reuses pane ids, and a tap after the id changed hands opened the new
// conversation (pre-release bug hunt). The occupant that was waiting comes too.
test("a notification tap names the conversation that was waiting, not only its pane id", async () => {
  const push = load();
  const notifications = require("expo-notifications");
  const open = jest.fn();
  notifications.getLastNotificationResponseAsync.mockResolvedValue({ notification: { request: { content: { data: { paneId: "w3:p1", serverId: "computer-a", instanceId: "term_a" } } } } });
  const cancel = push.onNotificationTapped(open);
  await flush();
  expect(open).toHaveBeenCalledWith("w3:p1", "computer-a", "term_a");
  cancel();
});

// Approving from the notification: the computer seals what an agent asks with
// a key this phone gives it, and only a computer that offers it gets one.
describe("a push key for sealed notifications", () => {
  const withTeam = ({ Constants }: { Constants: { expoConfig: unknown } }) => {
    Constants.expoConfig = { extra: { eas: { projectId: "proj-1" } }, ios: { appleTeamId: "6H24S2PL9V", bundleIdentifier: "app.shahi.mobile" } };
  };

  test("goes with the token only when the computer offers sealed notifications", async () => {
    const push = load(withTeam);
    const SecureStore = require("expo-secure-store");
    const client = { registerPush: jest.fn(async () => {}) };

    await push.enablePush(client as never);
    expect(client.registerPush).toHaveBeenLastCalledWith("ExponentPushToken[abc]");
    expect(client.registerPush.mock.calls[0]).toHaveLength(1);

    await push.enablePush(client as never, { sealed: true });
    const [token, key] = client.registerPush.mock.calls.at(-1)! as unknown as [string, string];
    expect(token).toBe("ExponentPushToken[abc]");
    expect(Buffer.from(key, "base64")).toHaveLength(32);
    // Where the extension finds it: the shared group, named by the id the
    // computer derives from it (`pushKeyId`), readable after first unlock.
    const id = require("node:crypto").createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 16);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(`shahi.push-key.${id}`, key, expect.objectContaining({
      keychainService: "shahi.push-keys",
      accessGroup: "6H24S2PL9V.app.shahi.mobile.push",
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    }));
  });

  test("a computer that refuses the registration leaves no key behind", async () => {
    const push = load(withTeam);
    const SecureStore = require("expo-secure-store");
    const client = { registerPush: jest.fn(async () => { throw new Error("offline"); }) };
    expect(await push.enablePush(client as never, { sealed: true })).toEqual({ ok: false, reason: "offline" });
    const [name] = (SecureStore.setItemAsync as jest.Mock).mock.calls.find(([n]: [string]) => n.startsWith("shahi.push-key."))!;
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(name, expect.objectContaining({ accessGroup: "6H24S2PL9V.app.shahi.mobile.push" }));
  });
});

describe("an answer chosen on a notification", () => {
  const action = (identifier: string, actionIdentifier: string) => ({
    actionIdentifier,
    notification: { request: { identifier, content: { data: {
      paneId: "w3:p1", serverId: "computer-a", instanceId: "term_a",
      answer: { promptId: "prompt-1", question: "Do you want to proceed?", context: ["python3 tip.py"], options: [{ index: 1, label: "Yes", title: "Yes" }, { index: 3, label: "No", title: "No" }] },
    } } } },
  });

  test("is handed on with its computer and occupant, once, though launch and listener both report it", async () => {
    let listener!: (r: unknown) => void;
    const push = load(({ Notifications }) => {
      Notifications.getLastNotificationResponseAsync!.mockResolvedValue(action("n-1", "shahi.option.3"));
      Notifications.addNotificationResponseReceivedListener!.mockImplementation((fn: (r: unknown) => void) => { listener = fn; return { remove: jest.fn() }; });
    });
    const open = jest.fn();
    const answer = jest.fn();
    push.onNotificationTapped(open, answer);
    await flush();
    listener(action("n-1", "shahi.option.3"));
    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer).toHaveBeenCalledWith(
      { paneId: "w3:p1", serverId: "computer-a", instanceId: "term_a" },
      { index: 3, label: "No", promptId: "prompt-1", question: "Do you want to proceed?", context: ["python3 tip.py"] },
    );
    expect(open).not.toHaveBeenCalled();

    // A tap on the same notification, not an action, opens the pane as always.
    listener({ ...action("n-1", "expo.modules.notifications.actions.DEFAULT") });
    expect(open).toHaveBeenCalledWith("w3:p1", "computer-a", "term_a");
  });
});
