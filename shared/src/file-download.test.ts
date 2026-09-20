import { test, expect } from 'bun:test';
import { downloadFileBytes } from './file-download';
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
