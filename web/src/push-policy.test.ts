import { describe, expect, it } from "bun:test";
import { checkPushConnection } from "./push-policy";

describe("notification consent belongs to a remembered computer", () => {
  it("rejects memory-only and signed-out browsers even if origin permission was already granted", () => {
    expect(() => checkPushConnection(true, { generation: 1, identity: {}, remembered: false }, 1)).toThrow("Remember this browser");
    expect(() => checkPushConnection(true, { generation: 1, identity: null, remembered: false }, 1)).toThrow("connection changed");
  });
  it("rejects an enrollment finishing after a new remembered pairing takes over", () => {
    expect(() => checkPushConnection(true, { generation: 2, identity: {}, remembered: true }, 1)).toThrow("connection changed");
    expect(() => checkPushConnection(true, { generation: 2, identity: {}, remembered: true }, 2)).not.toThrow();
  });
  it("preserves same-origin direct-sidecar enrollment", () => {
    expect(() => checkPushConnection(false, { generation: 0, identity: null, remembered: false }, 0)).not.toThrow();
  });
});
