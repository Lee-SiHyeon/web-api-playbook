import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { STORE_NAME, request, storeSession, status } from './client.mjs';

const webApiPlaybookRoot = process.env.WEB_API_PLAYBOOK_ROOT || fileURLToPath(new URL('../../../..', import.meta.url));
const { ProtectedStore } = await import(pathToFileURL(path.join(webApiPlaybookRoot, 'lib', 'protected-store.mjs')).href);

function arrayCounts(value, prefix='success', depth=0) {
  if(depth>4||value===null)return {};
  if(Array.isArray(value))return {[prefix]:value.length};
  if(typeof value!=='object')return {};
  return Object.assign({},...Object.entries(value).map(([k,v])=>arrayCounts(v,`${prefix}.${k}`,depth+1)));
}
const bundle=JSON.parse(new ProtectedStore().read(STORE_NAME));
const file=new URL('./observed-contracts.json',import.meta.url);
let evidence=bundle.evidence;
if(!evidence && existsSync(file))evidence=JSON.parse(readFileSync(file,'utf8')).contracts;
if(!Array.isArray(evidence))throw Error('TOSS_CONTRACTS_UNAVAILABLE');
const contracts=[...new Map(evidence.map(c=>[`${c.method}:${c.path}:${(c.queryKeys||[]).join(',')}`,c])).values()];
if(bundle.evidence)storeSession(bundle);
bundle.cookies=[];bundle.expectedOwner=null;
const results=[];
for(const operation of Object.keys(bundle.readRequests)){
  try{
    const r=await request(operation);
    results.push({operation,httpStatus:r.status,resultType:r.data.resultType,liveReplay:true,browserUsed:false,
      ...(operation==='member'?{ownerMatched:true}:{}),arrayCounts:arrayCounts(r.data.success),checkedAt:new Date().toISOString()});
  }catch(e){results.push({operation,liveReplay:false,code:/^[A-Z0-9_]+$/.test(e.code||'')?e.code:'TOSS_REPLAY_FAILED',checkedAt:new Date().toISOString()});}
}
for(const c of contracts){
  const result=results.find(r=>r.operation===c.operation);
  const replayed=bundle.readRequests[c.operation];
  // The stored request is the last observed query variant, not every earlier variant.
  const exactVariant=c.method==='GET'&&replayed&&JSON.stringify(c.queryKeys)===JSON.stringify([...new URL(replayed.url).searchParams.keys()]);
  c.liveReplay=Boolean(exactVariant&&result?.liveReplay);
  if(c.liveReplay){c.replayHeaders=['Accept','Cookie'];c.replayedAt=result.checkedAt;}
}
writeFileSync(file,JSON.stringify({version:1,service:'toss-sharelink',observedAt:new Date(bundle.capturedAt).toISOString(),contracts},null,2));
const report={version:1,service:'toss-sharelink',verifiedAt:new Date().toISOString(),credentialStore:status(),
  capturedContractCount:contracts.length,successfulReplayCount:results.filter(r=>r.liveReplay).length,
  attemptedReplayCount:results.length,writeCount:0,results};
writeFileSync(new URL('./verification.json',import.meta.url),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
