// Persist the worker's actual progress so the next scheduled run resumes it.
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquireRunLock } from '../lib/process-run-lock.mjs';
import { readScoutQueue, writeScoutQueue, checkpointScoutQueue, selectScoutWork } from '../lib/scout-onboarding.mjs';

const ROOT=fileURLToPath(new URL('../../../',import.meta.url));
export async function saveCheckpoint(root, change) {
  const evidence=path.resolve(root,change.evidenceFile||'');
  const relative=path.relative(root,evidence);
  if(!relative || relative==='..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))throw Error('SCOUT_EVIDENCE_OUTSIDE_REPO');
  await access(evidence);
  const queue=await readScoutQueue(root);
  if(!queue)throw Error('SCOUT_QUEUE_MISSING');
  const updated=checkpointScoutQueue(queue,{...change,evidenceFile:relative.replaceAll('\\','/')});
  await writeScoutQueue(root,updated);
  const saved=updated.services.find(row=>row.id===change.service);
  return {ok:true,service:change.service,status:saved.status,stage:saved.stage,nextWork:selectScoutWork(updated)};
}
async function main() {
  const args=process.argv.slice(2);
  if(args.length!==1||!args[0].startsWith('--checkpoint='))throw Error('SCOUT_CHECKPOINT_USAGE');
  const change=JSON.parse(await readFile(args[0].slice(13),'utf8'));
  const release=await acquireRunLock(path.join(ROOT,'workflow-runs/api-only-onboarding'));
  try {console.log(JSON.stringify(await saveCheckpoint(ROOT,change)));}finally{await release();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{
  console.error(JSON.stringify({ok:false,code:/^[A-Z][A-Z_]+$/.test(error.message)?error.message:'SCOUT_CHECKPOINT_FAILED'}));process.exitCode=1;
});
