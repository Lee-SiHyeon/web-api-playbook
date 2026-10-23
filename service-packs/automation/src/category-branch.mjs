import {readFile,writeFile,mkdir,open,rename,unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
export async function traverseBranch(file,seed,fetchBranch,{budget=20,intervalMs=2000}={}){
 if(!/^\d+$/.test(String(seed.linkcodes))||!/^\d+$/.test(String(seed.component))||!Number.isInteger(budget)||budget<1)throw Error('Observed seed and positive budget required');
 await mkdir(dirname(file),{recursive:true});const lockPath=file+'.lock';const lock=await open(lockPath,'wx');
 try{
  let state;
  try{state=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;state={version:1,seed,nodes:[{component:String(seed.component),categoryId:null,state:'pending',depth:0,attempts:0}],edges:[]};}
  if(String(state.seed.linkcodes)!==String(seed.linkcodes)||String(state.seed.component)!==String(seed.component))throw Error('Branch seed differs from saved checkpoint');
  const save=async()=>{const tmp=file+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(state,null,2));await rename(tmp,file);};
  let calls=0;
  while(calls<budget){
   const node=state.nodes.find(n=>n.state==='pending');if(!node)break;
   if(calls)await delay(intervalMs);
   calls++;node.attempts++;node.lastAttemptAt=new Date().toISOString();
   try{
    const result=await fetchBranch({linkcodes:seed.linkcodes,component:node.component});
    if(!Array.isArray(result.children))throw Error('Children schema missing');
    // Validate the complete response before adding any edges to the saved frontier.
    for(const child of result.children){
     if(!child||!/^\d+$/.test(String(child.id))||!/^\d+$/.test(String(child.linkCode))||!(typeof child.hasChild==='boolean'||child.hasChild===null))throw Error('Child identity schema mismatch');
    }
    if(result.children.some(c=>String(c.linkCode)===String(seed.linkcodes)))throw Object.assign(Error('Context navigation returned instead of descendants'),{code:'category_context_fallback'});
    for(const child of result.children){
     const component=String(child.id),edge={parentComponent:node.component,childComponent:component,type:'lazy-category-child'};
     if(!state.edges.some(e=>e.parentComponent===edge.parentComponent&&e.childComponent===component))state.edges.push(edge);
     if(!state.nodes.some(n=>n.component===component))state.nodes.push({component,categoryId:String(child.linkCode),url:child.linkUri,name:child.name,hasChild:child.hasChild,state:child.hasChild===false?'navigation-leaf':'pending',depth:node.depth+1,attempts:0});
    }
    node.state='replay-verified';node.responseHash=result.responseHash;node.childCount=result.children.length;
    node.lastResponseObservedAt=result.checkedAt??null;node.evidenceSource=result.replaySource??'direct-http';
   }catch(e){node.state='blocked';node.failure='Branch replay or schema validation failed; inspect contract before retry';const status=e.message?.match(/^Subcategory transport failure: HTTP (\d{3})$/);if(status)node.httpStatus=Number(status[1]);else node.errorClass=e.code??e.name;}
   state.checkedAt=new Date().toISOString();await save();
   if(node.state==='blocked')break; // Preserve siblings; do not fan a shared failure out to every selector.
  }
  const pending=state.nodes.filter(n=>n.state==='pending').length,blocked=state.nodes.filter(n=>n.state==='blocked').length;
  state.coverage={callsThisRun:calls,nodes:state.nodes.length,edges:state.edges.length,pending,blocked,navigationBranchExhausted:pending===0&&blocked===0,listingTraversalVerified:false,wholeSiteComplete:false};
  await save();return state.coverage;
 }finally{await lock.close();await unlink(lockPath);}
}
