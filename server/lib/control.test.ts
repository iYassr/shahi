import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicJson } from "../../plugin/releases/storage";
import { ComputerControl } from "./control";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "shahi-control-security-")); roots.push(root);
  atomicJson(join(root, "status.json"), { managed: true, phase: "idle", channel: "stable", current: "0.3.1" });
  return { root, control: new ComputerControl("fixture", () => ({ state: "offline", message: "offline" }), root) };
}
test("recovery refuses commands, URLs, release selection and malformed actions", () => {
  const { root, control } = fixture();
  for (const value of [null, [], "install", { action: "run" }, { action: "install", channel: "master" },
    { action: "install", url: "https://evil.example/code" }, { action: "install", command: "touch unwanted" },
    { action: "install", version: "0.1.0" }, { action: "install", channel: "stable", __proto__: null, artifact: {} }]) {
    expect(() => control.request(value)).toThrow("Invalid update request");
    expect(existsSync(join(root, "request.json"))).toBe(false);
  }
});
test("only a fixed request is published and a second request cannot overwrite it", () => {
  const { root, control } = fixture();
  control.request({ action: "install", channel: "stable" });
  expect(() => control.request({ action: "install", channel: "beta" })).toThrow("in progress");
  expect(JSON.parse(readFileSync(join(root, "request.json"), "utf8"))).toEqual({ action: "install", channel: "stable" });
});

// Both clients show a card with a message on every screen, and a development
// checkout said "Install the managed Shahi service…" on the Agents list and in
// every conversation; a fresh managed install said it too until its manager
// wrote a status (compatibility bug hunt).
test("an unmanaged computer's handshake carries no message for a card on every screen", () => {
  const h = new ComputerControl("dev", () => ({ state: "connected", version: "0.9.1", protocol: 22 }), undefined).handshake();
  expect(h.update).toMatchObject({ managed: false, phase: "idle" });
  expect(h.update.message).toBeUndefined();
  expect(h.capabilities).not.toContain("computer-updates");
});
test("a managed install before its manager's first status is managed and checking, not told to install itself", () => {
  const root = mkdtempSync(join(tmpdir(), "shahi-control-first-")); roots.push(root);
  const release = { version: "0.3.7", buildId: "b" };
  atomicJson(join(root, "installation.json"), { active: release, channel: "stable", sequence: {} });
  const h = new ComputerControl("fresh", () => ({ state: "offline", message: "offline" }), root).handshake();
  expect(h.update).toEqual({ managed: true, channel: "stable", phase: "checking", current: "0.3.7" });
  expect(h.capabilities).toContain("computer-updates");
});
