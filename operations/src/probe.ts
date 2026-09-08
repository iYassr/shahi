import { BOX_AUTH_PREFIX } from "../../shared/src/relay";

const b64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

/** A fresh synthetic box on every probe. Never addresses a user's computer or keys. */
export async function probeTunnel(origin: string, token: string): Promise<void> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const pub = await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer;
  const id = b64(await crypto.subtle.digest("SHA-256", pub));
  const sockets: WebSocket[] = [];
  const encoder = new TextEncoder();
  async function connect(role: string) {
    const response = await fetch(`${origin}/v1/${role}/${id}`, { headers: { upgrade: "websocket", "x-shahi-probe": token }, signal: AbortSignal.timeout(10_000) });
    const ws = response.webSocket;
    if (response.status !== 101 || !ws) throw new Error("upgrade failed");
    ws.binaryType = "arraybuffer";
    sockets.push(ws);
    const inbox = new Inbox(ws);
    ws.accept();
    return { ws, inbox };
  }
  try {
    const box = await connect("box");
    const challenge = JSON.parse(String(await box.inbox.next()));
    if (challenge.t !== "challenge" || typeof challenge.nonce !== "string") throw new Error("challenge failed");
    box.ws.send(JSON.stringify({ t: "auth", pub: b64(pub), sig: b64(await crypto.subtle.sign("Ed25519", pair.privateKey, encoder.encode(BOX_AUTH_PREFIX + id + challenge.nonce))) }));
    if (JSON.parse(String(await box.inbox.next())).t !== "ready") throw new Error("auth failed");
    const phone = await connect("phone");
    const opened = JSON.parse(String(await box.inbox.next()));
    if (opened.t !== "open") throw new Error("phone failed");
    phone.ws.send(new Uint8Array([17, 23, 42]));
    const frame = await box.inbox.next();
    if (!(frame instanceof ArrayBuffer) || frame.byteLength !== 7 || new DataView(frame).getUint32(0) !== opened.link || new Uint8Array(frame)[6] !== 42) throw new Error("forward failed");
    box.ws.send(frame);
    const echo = await phone.inbox.next();
    if (!(echo instanceof ArrayBuffer) || new Uint8Array(echo).join() !== "17,23,42") throw new Error("return failed");
  } finally { for (const ws of sockets) { try { ws.close(1000, "probe complete"); } catch {} } }
}

/** Register before accept/send, so a fast challenge cannot race the listener. */
class Inbox {
  #queue: (string | ArrayBuffer)[] = [];
  #waiter: { resolve(value: string | ArrayBuffer): void; reject(error: Error): void } | null = null;
  #failed = false;
  constructor(ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      if (this.#waiter) { const waiter = this.#waiter; this.#waiter = null; waiter.resolve(event.data as string | ArrayBuffer); }
      else if (this.#queue.length < 8) this.#queue.push(event.data as string | ArrayBuffer);
    });
    const fail = () => { this.#failed = true; this.#waiter?.reject(new Error("socket closed")); this.#waiter = null; };
    ws.addEventListener("close", fail); ws.addEventListener("error", fail);
  }
  next(): Promise<string | ArrayBuffer> {
    const queued = this.#queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.#failed) return Promise.reject(new Error("socket closed"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#waiter = null; reject(new Error("probe timeout")); }, 5000);
      this.#waiter = { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } };
    });
  }
}
