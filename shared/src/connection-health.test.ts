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
