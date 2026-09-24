// Discovery only. Saves schema/metadata, never credentials or raw bodies.
import fs from 'node:fs';
import path from 'node:path';
const out = path.join(import.meta.dirname, 'network-contracts.jsonl');
const seen = new Set();
const allowed = h => h === 'tistory.com' || h.endsWith('.tistory.com') || h === 'kakao.com' || h.endsWith('.kakao.com');
function urlShape(raw) {
  const u = new URL(raw);
  return {origin:u.origin, path:u.pathname, queryFields:[...new Set(u.searchParams.keys())]};
}
function fields(body) {
  if (!body) return [];
  try { return Object.keys(JSON.parse(body)); } catch {}
  return [...new Set(new URLSearchParams(body).keys())].filter(k=>k.length<100);
}
async function attach(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
  let id=0;
  const requests=new Map();
  ws.onmessage=e=>{
    const m=JSON.parse(e.data), p=m.params;
    if(m.method==='Network.requestWillBeSent') {
      const r=p.request;
      if(!allowed(new URL(r.url).hostname)) return;
      const item={time:new Date().toISOString(),requestId:p.requestId,method:r.method,...urlShape(r.url),resourceType:p.type,requestFields:fields(r.postData)};
      requests.set(p.requestId,item);
      fs.appendFileSync(out,JSON.stringify({event:'request',...item})+'\n');
      if(p.redirectResponse) fs.appendFileSync(out,JSON.stringify({event:'redirect',...urlShape(p.redirectResponse.url),status:p.redirectResponse.status})+'\n');
    }
    if(m.method==='Network.responseReceived' && requests.has(p.requestId)) {
      fs.appendFileSync(out,JSON.stringify({event:'response',...requests.get(p.requestId),status:p.response.status,mimeType:p.response.mimeType})+'\n');
    }
    if(m.method==='Network.loadingFinished' && requests.has(p.requestId)) {
      fs.appendFileSync(out,JSON.stringify({event:'finished',requestId:p.requestId,encodedDataLength:p.encodedDataLength})+'\n'); requests.delete(p.requestId);
    }
  };
  ws.send(JSON.stringify({id:++id,method:'Network.enable'}));
  if(t.url==='about:blank') ws.send(JSON.stringify({id:++id,method:'Page.navigate',params:{url:'https://i-never-stop-study.tistory.com/'}}));
  console.log('Capture attached to page; secrets omitted');
  ws.onclose=()=>seen.delete(t.id);
}
async function scan(){
  const targets=await (await fetch('http://127.0.0.1:9224/json/list')).json();
  for(const t of targets) if(t.type==='page' && !seen.has(t.id)) {seen.add(t.id);await attach(t);}
}
await scan();
setInterval(()=>scan().catch(e=>console.error(e.message)),1000);
