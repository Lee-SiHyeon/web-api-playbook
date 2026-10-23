// Read-only reconnaissance only: no login, cookies, challenge bypass, or writes.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const out = new URL('../captures/', import.meta.url);
const targets = [
  ['hana','https://www.hanatour.com/'],['modetour','https://www.modetour.com/'],['yellowballoon','https://www.ybtour.co.kr/'],
  ['verygood','https://www.verygoodtour.com/'],['interpark','https://travel.interpark.com/'],['lotte','https://www.lottetour.com/'],
  ['ttang','https://www.ttang.com/'],['yanolja','https://nol.yanolja.com/'],['goodchoice','https://www.goodchoice.kr/'],
  ['agoda','https://www.agoda.com/'],['trip','https://kr.trip.com/'],['expedia','https://www.expedia.co.kr/'],
  ['hotels','https://kr.hotels.com/'],['booking','https://www.booking.com/']
];
await mkdir(out,{recursive:true});
for (const [id,url] of targets) {
  const checkedAt=new Date().toISOString(); let meta;
  try { const r=await fetch(url,{redirect:'manual',headers:{accept:'text/html','user-agent':'affiliate-content-operations-research/1.0'},signal:AbortSignal.timeout(12000)});
    const bytes=new Uint8Array(await r.arrayBuffer());
    meta={id,url,checkedAt,status:r.status,location:r.headers.get('location'),contentType:r.headers.get('content-type'),bytes:bytes.length,bodySaved:bytes.length<=1048576};
    if(meta.bodySaved) await writeFile(new URL(`${id}-landing-1.html`,out),bytes,{flag:'w'});
  } catch(e) { meta={id,url,checkedAt,error:e.name==='TimeoutError'?'timeout':String(e.message).slice(0,160)}; }
  await writeFile(new URL(`${id}-landing-1.meta.json`,out),JSON.stringify(meta,null,2)+'\n');
  console.log(JSON.stringify(meta));
}
