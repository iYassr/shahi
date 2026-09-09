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
