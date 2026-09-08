/** Local workerd only; synthetic identities, no herdr or production endpoints. */
import { connectBox, connectPhone, newBox, startRelay, type Peer } from "../test/harness";

const count = Number(process.argv[2] ?? 1000);
if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error("Choose 1–1000 synthetic boxes");
const stop = await startRelay();
const records: { box: ReturnType<typeof newBox>; upstream: Peer; phone: Peer }[] = [];
const timings: number[] = [];
async function batches<T>(items: T[], fn: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += 50) await Promise.all(items.slice(i, i + 50).map(fn));
}
const started = performance.now();
try {
  await batches(Array.from({ length: count }), async () => {
    const box = newBox(), upstream = await connectBox(box), phone = await connectPhone(box);
    await upstream.text();
    phone.send(new Uint8Array([0]));
    upstream.send(await upstream.binary());
    await phone.binary();
    records.push({ box, upstream, phone });
  });
  console.log(JSON.stringify({ phase: "connected", boxes: count, phones: count, sockets: count * 2 }));
  for (let round = 0; round < 20; round++) {
    await Promise.all(records.map(async ({ upstream, phone }) => {
      const begin = performance.now();
      const payload = new Uint8Array(2048).fill(round);
      phone.send(payload);
      upstream.send(await upstream.binary());
      const received = await phone.binary();
      if (received.length !== payload.length || received[0] !== round) throw new Error("corrupt forwarding");
      timings.push(performance.now() - begin);
    }));
    // Exercise sustained traffic within the documented 64 KiB/s per-device quota.
    await Bun.sleep(100);
  }
  await batches(records, async (record) => {
    const oldPhone = record.phone;
    record.upstream = await connectBox(record.box);
    if ((await oldPhone.closed).code !== 4404) throw new Error("replacement did not release the old phone");
    record.phone = await connectPhone(record.box);
    await record.upstream.text();
    record.phone.send(new Uint8Array([42]));
    record.upstream.send(await record.upstream.binary());
    if ((await record.phone.binary())[0] !== 42) throw new Error("reconnect failed");
  });
  timings.sort((a, b) => a - b);
  console.log(JSON.stringify({ result: "passed", environment: "local workerd; WAF and global routing excluded", boxes: count, concurrentPhones: count,
    roundTrips: timings.length, reconnects: count, p50Ms: timings[Math.floor(timings.length * .5)], p95Ms: timings[Math.floor(timings.length * .95)],
    p99Ms: timings[Math.floor(timings.length * .99)], elapsedMs: performance.now() - started }));
} finally { for (const { upstream, phone } of records) { upstream.close(); phone.close(); } await Bun.sleep(100); stop(); }
