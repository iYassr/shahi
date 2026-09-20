/** Local forwarding load: opaque encrypted-sized chunks plus chat. This is not
 * a production SLA or an end-to-end upload test; real transfer tests cover that. */
import { connectBox, connectPhone, newBox, startRelay, type Peer } from "../test/harness";
const count = Number(process.argv[2] ?? 500);
if (!Number.isInteger(count) || count < 1 || count > 500) throw new Error("Choose 1–500 computers");
const stop = await startRelay();
const peers: { box: Peer; phone: Peer }[] = [];
const baseline: number[] = [], bulk: number[] = [];
const payload = new Uint8Array(Math.ceil(65536 * 4 / 3) + 512).fill(37);
const chat = new Uint8Array(2048).fill(29);
const begin = Date.now();
let maxRss = 0;
const memory = setInterval(() => { maxRss = Math.max(maxRss, process.memoryUsage().rss); }, 1000);
const percentile = (v: number[], p: number) => [...v].sort((a,b)=>a-b)[Math.floor(v.length*p)];
try {
  for (let start = 0; start < count; start += 25) await Promise.all(Array.from({ length: Math.min(25, count - start) }, async () => {
    const identity = newBox(), box = await connectBox(identity), phone = await connectPhone(identity);
    await box.text(); phone.send(new Uint8Array([0])); box.send(await box.binary()); await phone.binary();
    peers.push({ box, phone });
  }));
  console.log(JSON.stringify({ phase: "connected", count }));
  for (let round = 0; round < 33; round++) {
    const uploading = round >= 3;
    const started = Date.now();
    await Promise.all(peers.map(async ({ box, phone }) => {
      const start = performance.now();
      if (uploading) phone.send(payload);
      phone.send(chat);
      if (uploading) {
        const bytes = await box.binary();
        if (bytes.length !== payload.length + 4 || bytes.subarray(4).some(v=>v!==37)) throw new Error("Corrupt chunk");
        // Small receipt, as in the upload protocol, rather than echoing a file.
        box.send(bytes.subarray(0, 4 + 1)); await phone.binary();
      }
      box.send(await box.binary());
      const echoed = await phone.binary();
      if (echoed.length !== chat.length || echoed.some(v=>v!==29)) throw new Error("Corrupt chat");
      (uploading ? bulk : baseline).push(performance.now() - start);
    }));
    if (round % 5 === 0) console.log(JSON.stringify({ phase: "round", round }));
    await Bun.sleep(Math.max(0, 1700 - (Date.now() - started)));
  }
  console.log(JSON.stringify({ result:"passed", environment:"local workerd only", computers:count, chunks:count*30, bytes:count*30*payload.length,
    baselineP95Ms:percentile(baseline,.95), uploadChatP95Ms:percentile(bulk,.95), uploadChatP99Ms:percentile(bulk,.99),
    loadGeneratorMaxRssMiB:Math.round(maxRss/1048576), elapsedMs:Date.now()-begin,
    limitations:"Generator RSS is not Worker isolate memory; excludes real encryption, disk, WAF, global routing and long soak" }));
} finally { clearInterval(memory); for (const p of peers) { p.phone.close(); p.box.close(); } await Bun.sleep(100); stop(); }
