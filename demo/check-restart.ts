import {readFileSync} from 'node:fs';
const s=JSON.parse(readFileSync(process.env.HOME+'/.config/shahi-review-demo/credentials.json','utf8'));
const base='https://review.getshahi.dev';
const headers={authorization:'Basic '+btoa('reviewer:'+s.REVIEW_PASSWORD)};
const r=await fetch(base+'/_restart',{method:'POST',headers:{...headers,'x-operator-token':s.INTERNAL_TOKEN}});
if(!r.ok) throw new Error('Controlled restart failed: '+r.status);
console.log('PASS checkpoint and controlled cloud restart requested');
for(let i=0;i<12;i++) {
 const h=await fetch(base+'/health',{headers,signal:AbortSignal.timeout(150000)});
 const data=await h.json() as any;
 if(h.ok && data.ready && !data.checkpointError){console.log('PASS restarted cloud computer healthy with current checkpoint');process.exit(0);}
 await Bun.sleep(5000);
}
throw new Error('Restart did not recover');
