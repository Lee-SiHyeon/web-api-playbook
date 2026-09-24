// Public first-party research snapshots. No cookies, model calls or publishing.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const hash=b=>createHash('sha256').update(b).digest('hex');
export async function collectOfficial(config,out,{fetchImpl=fetch}={}) {
  if(config.schemaVersion!==1||!Array.isArray(config.sources)||config.sources.length>60)throw Error('CONFIG');
  const ids=new Set();
  for(const s of config.sources){const u=new URL(s.url);if(!/^[a-zA-Z0-9-]+$/.test(s.id)||ids.has(s.id)||u.protocol!=='https:'||u.username||u.password||u.port||!config.allowedHosts.includes(u.hostname))throw Error('SOURCE_SCOPE');ids.add(s.id);}
  await mkdir(out,{recursive:true});const manifest=[];
  for(const s of config.sources){const checkedAt=new Date().toISOString();try{
    const r=await fetchImpl(s.url,{redirect:'manual',credentials:'omit',signal:AbortSignal.timeout(20000),headers:{accept:'text/html,text/plain,application/json'}});
    const chunks=[];let size=0;for await(const c of r.body){size+=c.length;if(size>5000000)throw Error('SIZE_LIMIT');chunks.push(c);}const bytes=Buffer.concat(chunks);
    const evidenceFile=path.join(out,s.id+'.raw');await writeFile(evidenceFile,bytes,{flag:'wx'});
    manifest.push({...s,checkedAt,status:r.status,evidenceFile,sha256:hash(bytes),bytes:size,usable:r.status===200,claimsVerified:false});
  }catch(e){manifest.push({...s,checkedAt,status:null,usable:false,code:e.message==='SIZE_LIMIT'?'SIZE_LIMIT':'FETCH_FAILED',claimsVerified:false});}}
  const result={schemaVersion:1,kind:'official_frontier_snapshot',checkedAt:new Date().toISOString(),sources:manifest,policy:{publicOnly:true,credentialsPersisted:false,automaticRanking:false,missingScores:'null_not_zero',reviewRequired:true}};
  await writeFile(path.join(out,'manifest.json'),JSON.stringify(result,null,2),{flag:'wx'});return result;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){const [config,out]=process.argv.slice(2);if(!config||!out)throw Error('CONFIG_AND_NEW_OUTPUT_REQUIRED');const r=await collectOfficial(JSON.parse(await readFile(config,'utf8')),out);console.log(JSON.stringify({sources:r.sources.length,usable:r.sources.filter(s=>s.usable).length,output:out}));}
