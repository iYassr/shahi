/**
 * The relay against a real `wrangler dev`: every rule in "What the relay
 * does" (`docs/relay.md`), each test named for the behaviour it protects.
 * Every test mints its own box, so each one lands on a fresh Durable Object.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RELAY_CLOSE, RELAY_LIMITS } from "@shahi/shared";
import {
  HTTP,
  Peer,
  WS,
  connectBox,
  connectPhone,
  newBox,
  signAuth,
  startRelay,
  unframe,
} from "./harness.ts";

let stop: () => void;
beforeAll(async () => {
  stop = await startRelay();
}, 120_000);
afterAll(() => stop?.());

describe("front door", () => {
  test("a serverId that is not 43 base64url characters is a 400", async () => {
    expect((await fetch(`${HTTP}/v1/box/short`)).status).toBe(400);
    expect((await fetch(`${HTTP}/v1/phone/${"A".repeat(42)}`)).status).toBe(400);
    expect((await fetch(`${HTTP}/v1/phone/${"A".repeat(43)}`)).status).toBe(426);
    expect((await fetch(`${HTTP}/v1/phone/${"+".repeat(43)}`)).status).toBe(400);
  });

  test("anything but the two endpoints is a 404", async () => {
    expect((await fetch(`${HTTP}/`)).status).toBe(404);
    expect((await fetch(`${HTTP}/v1/box`)).status).toBe(404);
    expect((await fetch(`${HTTP}/v1/box/${"A".repeat(43)}/more`)).status).toBe(404);
  });
});

describe("box", () => {
  test("a box that signs the challenge with the key its id hashes to is ready", async () => {
    const box = newBox();
    const peer = await connectBox(box);
    peer.close();
  });

  test("a signature from a different key is 4401 even if it names the right id", async () => {
    const box = newBox();
    const impostor = newBox();
    const peer = await Peer.open(`${WS}/v1/box/${box.serverId}`);
    // The impostor signs the right message, but its key does not hash to box.serverId.
    peer.send(signAuth(impostor, await peer.challenge(), box.serverId));
    expect((await peer.closed).code).toBe(RELAY_CLOSE.unauthorized);
  });

  test("the right key with a bad signature is 4401", async () => {
    const box = newBox();
    const peer = await Peer.open(`${WS}/v1/box/${box.serverId}`);
    // Signed over the wrong nonce: a replayed auth from an earlier connection.
    const nonce = await peer.challenge();
    peer.send(signAuth(box, nonce.slice(1) + "A"));
    expect((await peer.closed).code).toBe(RELAY_CLOSE.unauthorized);
  });

  test("anything that is not an auth is 4401", async () => {
    const box = newBox();
    const peer = await Peer.open(`${WS}/v1/box/${box.serverId}`);
    await peer.text();
    peer.send(new Uint8Array([0, 0, 0, 1, 42]));
    expect((await peer.closed).code).toBe(RELAY_CLOSE.unauthorized);
  });

  test("ten seconds of silence after the challenge is 4401", async () => {
    const box = newBox();
    const peer = await Peer.open(`${WS}/v1/box/${box.serverId}`);
    await peer.text();
    const closed = await peer.closed;
    expect(closed.code).toBe(RELAY_CLOSE.unauthorized);
    expect(closed.reason).toBe("auth timeout");
  }, RELAY_LIMITS.boxAuthTimeoutMs + 5_000);

  test("a second box replaces the first with 4409, and the first's phones learn the box is gone", async () => {
    const box = newBox();
    const first = await connectBox(box);
    const phone = await connectPhone(box);
    expect(await first.text()).toEqual({ t: "open", link: 1 });
    const second = await connectBox(box);
    expect((await first.closed).code).toBe(RELAY_CLOSE.replaced);
    expect((await phone.closed).code).toBe(RELAY_CLOSE.boxOffline);
    // The newcomer inherits nothing: its first phone is its link 1.
    const again = await connectPhone(box);
    expect(await second.text()).toEqual({ t: "open", link: 1 });
    again.close();
    second.close();
  });

  test("a box connection that has not authenticated cannot knock the real box off", async () => {
    const box = newBox();
    const real = await connectBox(box);
    const pretender = await Peer.open(`${WS}/v1/box/${box.serverId}`);
    await pretender.text();
    const phone = await connectPhone(box);
    expect(await real.text()).toEqual({ t: "open", link: 1 });
    pretender.close();
    phone.close();
    real.close();
  });
});

describe("phone", () => {
  test("a phone with no box is closed at once with 4404", async () => {
    const box = newBox();
    const phone = await connectPhone(box);
    expect((await phone.closed).code).toBe(RELAY_CLOSE.boxOffline);
  });

  test("a frame goes phone → box with the link prefixed, and back with it stripped", async () => {
    const box = newBox();
    const boxPeer = await connectBox(box);
    const phone = await connectPhone(box);
    expect(await boxPeer.text()).toEqual({ t: "open", link: 1 });

    phone.send(new Uint8Array([1, 2, 3]));
    const up = unframe(await boxPeer.binary());
    expect(up.link).toBe(1);
    expect([...up.payload]).toEqual([1, 2, 3]);

    boxPeer.send(new Uint8Array([0, 0, 0, 1, 9, 8]));
    expect([...(await phone.binary())]).toEqual([9, 8]);

    phone.close();
    boxPeer.close();
  });

  test("two phones get distinct links and each hears only its own frames", async () => {
    const box = newBox();
    const boxPeer = await connectBox(box);
    const a = await connectPhone(box);
    const b = await connectPhone(box);
    expect(await boxPeer.text()).toEqual({ t: "open", link: 1 });
    expect(await boxPeer.text()).toEqual({ t: "open", link: 2 });

    b.send(new Uint8Array([7]));
    const up = unframe(await boxPeer.binary());
    expect(up.link).toBe(2);

    boxPeer.send(new Uint8Array([0, 0, 0, 2, 22]));
    expect([...(await b.binary())]).toEqual([22]);
    expect(await a.hears()).toBe(false);

    boxPeer.send(new Uint8Array([0, 0, 0, 1, 11]));
    expect([...(await a.binary())]).toEqual([11]);

    a.close();
    b.close();
    boxPeer.close();
  });

  test("a phone leaving tells the box close, and a link number is never reused", async () => {
    const box = newBox();
    const boxPeer = await connectBox(box);
    const a = await connectPhone(box);
    expect(await boxPeer.text()).toEqual({ t: "open", link: 1 });
    a.close();
    expect(await boxPeer.text()).toEqual({ t: "close", link: 1 });
    const b = await connectPhone(box);
    expect(await boxPeer.text()).toEqual({ t: "open", link: 2 });
    b.close();
    boxPeer.close();
  });

  test("the box can end a link, and the phone is closed normally", async () => {
    const box = newBox();
    const boxPeer = await connectBox(box);
    const phone = await connectPhone(box);
    await boxPeer.text();
    boxPeer.send({ t: "close", link: 1 });
    expect((await phone.closed).code).toBe(1000);
    // The box asked, so it is not told.
    expect(await boxPeer.hears()).toBe(false);
    boxPeer.close();
  });

  test("the ninth phone is refused with 4429", async () => {
    const box = newBox();
    const boxPeer = await connectBox(box);
    const phones: Peer[] = [];
    for (let i = 0; i < RELAY_LIMITS.maxPhonesPerBox; i++) {
      phones.push(await connectPhone(box));
      expect(await boxPeer.text()).toEqual({ t: "open", link: i + 1 });
    }
    const ninth = await connectPhone(box);
    expect((await ninth.closed).code).toBe(RELAY_CLOSE.quota);
    // Room again once one leaves.
    phones[0]!.close();
    expect(await boxPeer.text()).toEqual({ t: "close", link: 1 });
    const tenth = await connectPhone(box);
    expect(await boxPeer.text()).toEqual({ t: "open", link: 9 });
    for (const p of [...phones, tenth]) p.close();
    boxPeer.close();
  });

  test("a phone that opens a link but never speaks is closed, freeing the slot", async () => {
    // Eight silent sockets would otherwise hold every slot for the full idle
    // window and lock the owner's real phone out (pentest H2). A phone hellos
    // the instant it opens; one that says nothing is cut after phoneHelloMs.
    const box = newBox();
    const boxPeer = await connectBox(box);
    const squatter = await connectPhone(box);
    expect(await boxPeer.text()).toEqual({ t: "open", link: 1 });
    // It never sends a frame. The relay closes it normally and tells the box.
    const closed = await squatter.closed;
    expect(closed.code).toBe(1000);
    expect(closed.reason).toBe("no hello");
    expect(await boxPeer.text()).toEqual({ t: "close", link: 1 });
    // A phone that does speak keeps its slot: its frame reaches the box, and
    // it is not cut when the deadline it would have had passes.
    const real = await connectPhone(box);
    expect(await boxPeer.text()).toEqual({ t: "open", link: 2 });
    real.send(new Uint8Array([7, 8, 9]));
    expect(unframe(await boxPeer.binary())).toMatchObject({ link: 2 });
    real.close();
    boxPeer.close();
  }, RELAY_LIMITS.phoneHelloMs + 8_000);

  test("a frame over 1 MiB closes the phone with 4429 and the box is told", async () => {
    const box = newBox();
    const boxPeer = await connectBox(box);
    const phone = await connectPhone(box);
    await boxPeer.text();
    phone.send(new Uint8Array(RELAY_LIMITS.maxFrameBytes + 1));
    const closed = await phone.closed;
    expect(closed.code).toBe(RELAY_CLOSE.quota);
    expect(closed.reason).toBe("frame too large");
    expect(await boxPeer.text()).toEqual({ t: "close", link: 1 });
    boxPeer.close();
  });

  test("a phone may spend its burst once, then is closed with 4429 for the rate", async () => {
    const box = newBox();
    const boxPeer = await connectBox(box);
    const phone = await connectPhone(box);
    await boxPeer.text();
    // Exactly the burst is allowed and forwarded; a second burst at once is not.
    phone.send(new Uint8Array(RELAY_LIMITS.phoneBurstBytes));
    expect((await boxPeer.binary()).byteLength).toBe(RELAY_LIMITS.phoneBurstBytes + 4);
    phone.send(new Uint8Array(RELAY_LIMITS.phoneBurstBytes));
    const closed = await phone.closed;
    expect(closed.code).toBe(RELAY_CLOSE.quota);
    expect(closed.reason).toBe("rate");
    boxPeer.close();
  }, 15_000);

  test("a text frame from a phone is dropped, not forwarded", async () => {
    const box = newBox();
    const boxPeer = await connectBox(box);
    const phone = await connectPhone(box);
    await boxPeer.text();
    phone.send('{"t":"close","link":1}');
    expect(await boxPeer.hears()).toBe(false);
    // The link is still up.
    phone.send(new Uint8Array([5]));
    expect(unframe(await boxPeer.binary()).link).toBe(1);
    phone.close();
    boxPeer.close();
  });

  test("when the box disconnects its phones are closed with 4404", async () => {
    const box = newBox();
    const boxPeer = await connectBox(box);
    const phone = await connectPhone(box);
    await boxPeer.text();
    boxPeer.close();
    expect((await phone.closed).code).toBe(RELAY_CLOSE.boxOffline);
  });

  test("a box frame for a link that does not exist is dropped", async () => {
    const box = newBox();
    const boxPeer = await connectBox(box);
    const phone = await connectPhone(box);
    await boxPeer.text();
    boxPeer.send(new Uint8Array([0, 0, 0, 7, 1]));
    boxPeer.send(new Uint8Array([1]));
    expect(await phone.hears()).toBe(false);
    phone.close();
    boxPeer.close();
  });

  test("a ping from either side is answered pong without reaching the other", async () => {
    const box = newBox();
    const boxPeer = await connectBox(box);
    const phone = await connectPhone(box);
    await boxPeer.text();
    boxPeer.send("ping");
    expect(await boxPeer.next()).toBe("pong");
    phone.send("ping");
    expect(await phone.next()).toBe("pong");
    expect(await boxPeer.hears()).toBe(false);
    phone.close();
    boxPeer.close();
  });
});
