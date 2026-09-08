import { expect, test } from "bun:test";
import { connectionHealth } from "./connection-health";
import { UnreachableError, IncompatibleServerError } from "./errors";
test("a confirmed disconnected computer is distinguished from a network outage", () => {
  const args = { link: "lost" as const, transport: "relay" as const };
  expect(connectionHealth({ ...args, error: new UnreachableError("box", "relay", "offline") })?.title).toBe("Computer disconnected");
  expect(connectionHealth({ ...args, online: false })?.title).toBe("You’re offline");
  expect(connectionHealth(args)?.title).toBe("Connection interrupted");
});
test("recovery instructions follow the actual transport and upgrade errors stay visible", () => {
  expect(connectionHealth({ link: "lost", transport: "ssh" })?.detail).toContain("reopen the tunnel");
  expect(connectionHealth({ link: "live", transport: "relay" })).toBeNull();
  expect(connectionHealth({ link: "live", transport: "relay", error: new IncompatibleServerError("Update Shahi on your computer", { min: 2, max: 2 }) })?.detail).toBe("Update Shahi on your computer");
});
