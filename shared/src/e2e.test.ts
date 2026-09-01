import { describe, expect, test } from "bun:test";
import {
  ephemeral,
  clientSession,
  serverSession,
  seal,
  open,
  PAIRING_SECRET_LEN,
  type Session,
} from "./e2e";

const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const utf8 = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array) => new TextDecoder().decode(b);

/** A paired client/server, sharing the given secret (a fresh one by default). */
function handshake(secret = rand(PAIRING_SECRET_LEN)): { client: Session; server: Session } {
  const clientKey = ephemeral(rand(32));
  const serverKey = ephemeral(rand(32));
  // Each side sees the other's public key — that is all that crosses the wire.
  const client = clientSession(clientKey, serverKey.pub, secret);
  const server = serverSession(serverKey, clientKey.pub, secret);
  return { client, server };
}

describe("e2e", () => {
  test("a message sealed by the client opens on the server", () => {
    const { client, server } = handshake();
    const wire = seal(client, utf8("run: ls -la"));
    expect(str(open(server, wire))).toBe("run: ls -la");
  });

  test("the reverse direction works too, independently", () => {
    const { client, server } = handshake();
    expect(str(open(client, seal(server, utf8("agent is blocked"))))).toBe("agent is blocked");
    expect(str(open(server, seal(client, utf8("answer 2"))))).toBe("answer 2");
  });

  test("both directions carry a stream in order", () => {
    const { client, server } = handshake();
    for (let i = 0; i < 50; i++) {
      expect(str(open(server, seal(client, utf8(`c2s ${i}`))))).toBe(`c2s ${i}`);
      expect(str(open(client, seal(server, utf8(`s2c ${i}`))))).toBe(`s2c ${i}`);
    }
  });

  test("a party with the wrong pairing secret cannot decrypt (MITM refused)", () => {
    // Same ephemeral exchange, but the two sides mixed in different secrets —
    // exactly what a man in the middle who lacks the pairing secret would face.
    const clientKey = ephemeral(rand(32));
    const serverKey = ephemeral(rand(32));
    const client = clientSession(clientKey, serverKey.pub, rand(PAIRING_SECRET_LEN));
    const server = serverSession(serverKey, clientKey.pub, rand(PAIRING_SECRET_LEN));
    expect(() => open(server, seal(client, utf8("secret")))).toThrow();
  });

  test("tampering with the ciphertext is detected", () => {
    const { client, server } = handshake();
    const wire = seal(client, utf8("do not flip me"));
    wire[wire.length - 1] = wire[wire.length - 1]! ^ 0x01; // flip a bit in the tag
    expect(() => open(server, wire)).toThrow();
  });

  test("tampering with the counter is detected", () => {
    const { client, server } = handshake();
    const wire = seal(client, utf8("payload"));
    wire[0] = wire[0]! ^ 0x01; // change the claimed counter → wrong nonce → bad tag
    expect(() => open(server, wire)).toThrow();
  });

  test("replaying a frame is refused", () => {
    const { client, server } = handshake();
    const wire = seal(client, utf8("once"));
    expect(str(open(server, wire))).toBe("once");
    expect(() => open(server, wire)).toThrow(/replay|order/i);
  });

  test("an old (lower-counter) frame is refused after a later one", () => {
    const { client, server } = handshake();
    const first = seal(client, utf8("first"));
    const second = seal(client, utf8("second"));
    open(server, second); // accept the later one first
    expect(() => open(server, first)).toThrow(/replay|order/i);
  });

  test("distinct nonces: 1000 seals never collide on the counter", () => {
    const { client } = handshake();
    const counters = new Set<string>();
    for (let i = 0; i < 1000; i++) counters.add(seal(client, utf8("x")).slice(0, 8).join(","));
    expect(counters.size).toBe(1000);
  });

  test("empty and binary payloads round-trip", () => {
    const { client, server } = handshake();
    expect(open(server, seal(client, new Uint8Array(0))).length).toBe(0);
    const binary = rand(4096);
    expect(open(server, seal(client, binary))).toEqual(binary);
  });

  test("a truncated frame is rejected, not mis-parsed", () => {
    const { client, server } = handshake();
    const wire = seal(client, utf8("hello"));
    expect(() => open(server, wire.slice(0, 10))).toThrow();
  });

  // The three properties the 2026-09-02 review demonstrated were missing,
  // each pinned by the demonstration turned around.
  test("a frame after a gap is refused: a relay cannot silently drop one", () => {
    const { client, server } = handshake();
    const withheld = seal(server, utf8('{"t":"ws","data":{"type":"status"}}'));
    const later = seal(server, utf8('{"t":"res","id":1,"status":200}'));
    void withheld;
    expect(() => open(client, later)).toThrow(/missing|dropped/i);
    // And the window did not move: the withheld frame, delivered late, still opens.
    expect(client.recv.next).toBe(0n);
    expect(str(open(client, withheld))).toContain("status");
    expect(str(open(client, later))).toContain("res");
  });

  test("a pairing secret of the wrong length is refused, never unauthenticated DH", () => {
    expect(() => handshake(new Uint8Array(0))).toThrow(/pairing secret/);
    expect(() => handshake(rand(16))).toThrow(/pairing secret/);
  });

  test("a low-order public key is refused at the handshake", () => {
    // What a hostile peer, or a relay rewriting the hello, can send as `pub`:
    // the all-zero point. noble throws; callers must catch (relay-client does).
    const self = ephemeral(rand(32));
    expect(() => serverSession(self, new Uint8Array(32), rand(PAIRING_SECRET_LEN))).toThrow();
    expect(() => clientSession(self, new Uint8Array(32), rand(PAIRING_SECRET_LEN))).toThrow();
  });
});
