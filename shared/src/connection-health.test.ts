import { expect, test } from "bun:test";
import { connectionHealth } from "./connection-health";
import { HostKeyError, UnreachableError, IncompatibleServerError } from "./errors";
test("a confirmed disconnected computer is distinguished from a network outage", () => {
  const args = { link: "lost" as const, transport: "relay" as const };
  expect(connectionHealth({ ...args, error: new UnreachableError("box", "relay", "offline") })?.title).toBe("Computer disconnected");
  expect(connectionHealth({ ...args, online: false })?.title).toBe("You’re offline");
  expect(connectionHealth(args)?.title).toBe("Reconnecting to your computer…");
});
test("recovery instructions follow the actual transport and upgrade errors stay visible", () => {
  expect(connectionHealth({ link: "lost", transport: "ssh" })?.detail).toContain("reconnect securely");
  expect(connectionHealth({ link: "live", transport: "relay" })).toBeNull();
  expect(connectionHealth({ link: "live", transport: "relay", error: new IncompatibleServerError("Update Shahi on your computer", { min: 2, max: 2 }) })?.detail).toBe("Update Shahi on your computer");
});

test("reconnecting uses the saved name without guessing sleep or losing pairing", () => {
  const health = connectionHealth({ link: "lost", transport: "relay", computerName: "My Mac" });
  expect(health?.title).toBe("Reconnecting to My Mac…");
  expect(health?.detail).toContain("don’t need to pair again");
  expect(health?.detail).not.toContain("asleep");
});

// A reinstalled SSH server: the saved computer refuses its new key before any
// login and cannot recover by retrying. It used to say "Reconnecting…" for good.
test("an SSH server presenting a key this phone does not trust says what to check, not that it is reconnecting", () => {
  const refusal = new HostKeyError("This computer’s host key has changed since you trusted it, so your login was not sent.");
  const health = connectionHealth({ link: "lost", transport: "ssh", error: refusal });
  expect(health?.title).toBe("Check this computer’s identity");
  expect(health?.detail).toBe(refusal.message);
});

// herdr stopped while the socket stayed open: the header said LIVE and an open
// pane showed nothing wrong until a send failed (pre-release bug hunt).
test("herdr stopped behind a live link says so, naming the computer", () => {
  const offline = { state: "offline" as const, message: "herdr is offline. Shahi will reconnect automatically." };
  const health = connectionHealth({ link: "live", transport: "relay", computerName: "My Mac", backend: offline });
  expect(health?.title).toBe("herdr isn’t running on My Mac");
  expect(health?.detail).toBe(offline.message);
  expect(connectionHealth({ link: "live", transport: "relay", backend: { state: "connected", version: "0.9.1", protocol: 22 } })).toBeNull();
});

test("a request refused because herdr is unavailable is not called reconnecting", () => {
  const refusal = Object.assign(new Error("herdr is offline. Shahi will reconnect automatically."), { code: "backend_unavailable" });
  const health = connectionHealth({ link: "lost", transport: "relay", computerName: "My Mac", error: refusal });
  expect(health?.title).toBe("herdr isn’t available on My Mac");
  expect(health?.detail).toBe(refusal.message);
});
