import {mkdir,open,readFile,rename,unlink} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {mergeCategoryFrontier} from './category-frontier.mjs';

// The lock spans retrieval and replacement: concurrent refreshes cannot overwrite checkpoints.
// All writers of this frontier must use the same lock; abandoned locks require reconciliation.
export async function refreshCategories(file,fetchTree){
 file=resolve(file);
 await mkdir(dirname(file),{recursive:true});
 const lockPath=file+'.lock';
 const lock=await open(lockPath,'wx');
 const temp=file+'.'+randomUUID()+'.tmp';
 try{
  let previous;
  try{previous=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const fresh=await fetchTree();
  const frontier=previous?mergeCategoryFrontier(previous,fresh):fresh;
  const output=await open(temp,'wx');
  try{await output.writeFile(JSON.stringify(frontier,null,2));await output.sync();}finally{await output.close();}
  await rename(temp,file);
  return {file,checkedAt:fresh.checkedAt,httpStatus:fresh.httpStatus,responseHash:fresh.responseHash,categories:frontier.nodes.length,containers:frontier.containers.length,states:frontier.nodes.reduce((a,n)=>(a[n.state]=(a[n.state]??0)+1,a),{}),coverage:frontier.coverage};
 }finally{await unlink(temp).catch(()=>{});await lock.close();await unlink(lockPath);}
}
