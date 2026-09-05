import { afterEach, describe, expect, it } from "bun:test";
import { readPairing, takePairingFragment } from "./connection";
const oldLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
const oldHistory = Object.getOwnPropertyDescriptor(globalThis, "history");
const secret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const native = (relay: string) => `shahi://pair#v=1&server=${secret}&secret=${secret}&relay=${encodeURIComponent(relay)}`;
function page(hostname: string) { Object.defineProperty(globalThis, "location", { configurable: true, value: { hostname } }); }
afterEach(() => {
  for (const [key, descriptor] of [["location", oldLocation], ["history", oldHistory]] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
describe("browser pairing security", () => {
  it("accepts native and hosted QR codes without sending secrets as URLs", () => {
    page("getshahi.dev");
    expect(readPairing(native("https://relay.example")).relay).toBe("https://relay.example");
    expect(readPairing(`https://getshahi.dev/pwa/#pair=${encodeURIComponent(native("https://relay.example"))}`).secret).toBe(secret);
  });
  it("refuses insecure, credential-bearing and malformed relay targets", () => {
    page("getshahi.dev");
    for (const relay of ["http://relay.example", "http://127.0.0.1:18777", "https://user:secret@relay.example", "https://relay.example/path", "https://relay.example?secret=leak", "https://relay.example#secret=leak"]) {
      expect(() => readPairing(native(relay))).toThrow();
    }
    expect(() => readPairing(native("https://relay.example").replace(`server=${secret}`, "server=../elsewhere"))).toThrow();
  });
  it("allows loopback relay fixtures only from a local browser origin", () => {
    page("localhost");
    expect(readPairing(native("http://127.0.0.1:18777")).relay).toBe("http://127.0.0.1:18777");
  });
  it("removes every fragment from browser history immediately", () => {
    let replacement = "";
    Object.defineProperty(globalThis, "location", { configurable: true, value: { hash: `#pair=${encodeURIComponent(native("https://relay.example"))}`, pathname: "/pwa/", search: "" } });
    Object.defineProperty(globalThis, "history", { configurable: true, value: { replaceState(_state: unknown, _title: string, url: string) { replacement = url; } } });
    expect(takePairingFragment()).toBe(native("https://relay.example"));
    expect(replacement).toBe("/pwa/");
  });
});
