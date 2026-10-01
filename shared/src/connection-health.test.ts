import { expect, test } from "bun:test";
import { connectionHealth, graceUntil, RECONNECT_GRACE_MS } from "./connection-health";
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

// Build 28 on a phone (October 2026): back in the foreground, the full
// "Computer disconnected" card stood for ten seconds over a computer that
// came back by itself. Such a notice is marked transient and has a one-line form.
test("a computer or relay that did not answer, and a link coming back, are transient; causes that need the person are not", () => {
  const relay = { link: "lost" as const, transport: "relay" as const, computerName: "Mac" };
  for (const error of [new UnreachableError("box", "relay", "offline"), new UnreachableError("relay", "relay", "down"), null]) {
    const health = connectionHealth({ ...relay, error });
    expect(health?.transient).toBe(true);
    expect(health?.brief).toBe("Reconnecting to Mac…");
  }
  expect(connectionHealth({ link: "connecting", transport: "relay", computerName: "Mac" })?.brief).toBe("Connecting to Mac…");
  expect(connectionHealth({ ...relay, online: false })?.transient).toBeUndefined();
  expect(connectionHealth({ ...relay, error: new HostKeyError("changed") })?.transient).toBeUndefined();
  expect(connectionHealth({ ...relay, error: new IncompatibleServerError("Update", { min: 2, max: 2 }) })?.transient).toBeUndefined();
});

test("the grace holds a transient notice back once, and only after a live link or a resume", () => {
  // A drop from a live link: brief for the grace, decided once.
  const until = graceUntil(null, true, true, 1_000);
  expect(until).toBe(1_000 + RECONNECT_GRACE_MS);
  expect(graceUntil(until, true, true, 5_000)).toBe(until);
  // A screen opened on a computer already gone: the full card at once.
  expect(graceUntil(null, true, false, 1_000)).toBe(0);
  // Recovered, or no longer transient: nothing held, and the next drop starts afresh.
  expect(graceUntil(until, false, true, 2_000)).toBeNull();
});
