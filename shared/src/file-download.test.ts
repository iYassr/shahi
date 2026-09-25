import { test, expect } from 'bun:test';
import { FileDownloadError, downloadFileBytes, fileRefusal } from './file-download';
const data=new Uint8Array(1_300_007).map((_,i)=>i%251);
function source(change=false) {
 let count=0;
 return async (headers:Record<string,string>)=>{
  const [,a,b]=headers.range!.match(/bytes=(\d+)-(\d+)/)!;
  const start=Number(a),end=Math.min(Number(b),data.length-1);count++;
  return {ok:true,status:206,headers:new Headers({'content-range':`bytes ${start}-${end}/${data.length}`,'content-type':'application/pdf','x-shahi-file-version':change && count>1?'changed':'original'}),bytes:async()=>data.slice(start,end+1)};
 };
}
test('large encrypted downloads assemble exact bytes in bounded ranges',async()=>{
 const result=await downloadFileBytes(source());expect(result.bytes).toEqual(data);expect(result.contentType).toBe('application/pdf');
});
test('a file changed during transfer is rejected rather than mixed',async()=>{await expect(downloadFileBytes(source(true))).rejects.toThrow('changed');});
test('old servers still return small files without ranges',async()=>{
 const result=await downloadFileBytes(async()=>({ok:true,status:200,headers:new Headers(),bytes:async()=>new Uint8Array([1,2])}));expect(result.bytes).toEqual(new Uint8Array([1,2]));
});
test('malformed ranges and huge announced files fail closed',async()=>{
 for(const range of ['bytes 1-2/3','bytes 0-1/999999999','bytes 0-0/0']) await expect(downloadFileBytes(async()=>({ok:true,status:206,headers:new Headers({'content-range':range,'x-shahi-file-version':'a'}),bytes:async()=>new Uint8Array([1,2])}))).rejects.toThrow();
});

/**
 * Shahi 0.3.6 answered ranges with 206, but its relay client passed on only
 * content-type, etag and cache-control, so the range and the version never
 * reached the phone. Found in the September 2026 pre-release bug hunt: every
 * PDF and every Save/Share from such a computer failed as "incomplete", even
 * a 584-byte file. Without a range it answers as older computers do: whole,
 * or the relay's 413 when the file will not fit in one frame.
 */
function computer036(file: Uint8Array, relayFrame = 783_000) {
  const asked: Record<string, string>[] = [];
  const request = async (headers: Record<string, string>) => {
    asked.push(headers);
    const range = headers.range?.match(/^bytes=(\d+)-(\d+)$/);
    if (range) {
      const slice = file.slice(Number(range[1]), Number(range[2]) + 1);
      return { ok: true, status: 206, headers: new Headers({ 'content-type': 'application/pdf' }), bytes: async () => slice };
    }
    if (file.length > relayFrame) {
      return { ok: false, status: 413, headers: new Headers({ 'content-type': 'application/json' }), bytes: async () => new TextEncoder().encode(JSON.stringify({ error: 'too large to send through the relay' })) };
    }
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/pdf' }), bytes: async () => file };
  };
  return { request, asked };
}

test('a 0.3.6 computer whose relay dropped the range headers still opens a small PDF', async () => {
  const pdf = new Uint8Array(584).map((_, i) => i % 7);
  const { request, asked } = computer036(pdf);
  const result = await downloadFileBytes(request);
  expect(result.bytes).toEqual(pdf);
  expect(result.contentType).toBe('application/pdf');
  // Asked once with a range, then once without.
  expect(asked.map(h => h.range ?? null)).toEqual(['bytes=0-524287', null]);
});

test('a 0.3.6 computer with a PDF too large for one relay frame is told to update, not that the file is incomplete', async () => {
  const { request } = computer036(new Uint8Array(900_000));
  const refused = await downloadFileBytes(request).catch((e: unknown) => e);
  expect(refused).toBeInstanceOf(FileDownloadError);
  expect((refused as Error).message).toBe('This computer needs an update to download larger files through the relay.');
});

const refusal = (status: number, body: unknown) => async () => ({
  ok: false, status, headers: new Headers({ 'content-type': 'application/json' }),
  bytes: async () => new TextEncoder().encode(JSON.stringify(body)),
});

// Every 413 said "needs an update", including a current computer's 25 MB
// ceiling, and over SSH, where no relay is involved.
test('a file over the 25 MB ceiling is too large, from a current computer or an older one', async () => {
  for (const body of [{ error: 'This file is over 25 MB.', code: 'file_too_large' }, { error: 'file is 27262976 bytes, over the 26214400 limit' }]) {
    const refused = await downloadFileBytes(refusal(413, body)).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(FileDownloadError);
    expect((refused as Error).message).toContain('over 25 MB');
    expect((refused as Error).message).not.toContain('update');
  }
  const relayFrame = await downloadFileBytes(refusal(413, { error: 'too large to send through the relay' })).catch((e: unknown) => e);
  expect((relayFrame as Error).message).toContain('needs an update');
});

test("a folder, a file outside home and a missing file are refused in the computer's own words", async () => {
  for (const [status, error] of [[400, 'That is a folder, not a file.'], [403, 'That file is outside your home folder, so Shahi will not open it.'], [404, 'That file is not there any more.']] as const) {
    const refused = await downloadFileBytes(refusal(status, { error })).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(FileDownloadError);
    expect((refused as Error).message).toBe(error);
  }
  expect(fileRefusal(503, { error: 'this box is busy; try again shortly' })).toContain('Check your connection');
});
