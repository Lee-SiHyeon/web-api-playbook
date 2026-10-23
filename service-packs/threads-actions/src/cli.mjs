import {ThreadsClient,ThreadsError} from './client.mjs';
import {openProvider} from './provider.mjs';
const read=async()=>{let s='';for await(const c of process.stdin)s+=c;return s;};
try{
  let job;try{job=JSON.parse(await read());}catch{throw new ThreadsError('JOB_JSON');}
  if(!['profile','views','publish'].includes(job.operation))throw new ThreadsError('OPERATION_DENIED');
  const execute=process.argv.includes('--execute');
  let provider;
  if(job.operation==='publish'&&execute)provider=await openProvider({modulePath:process.env.THREADS_SESSION_PROVIDER_MODULE});
  const client=new ThreadsClient({provider});
  let result;
  try{
    if(job.operation==='profile')result=await client.profile(job.handle,{limit:job.limit??5});
    if(job.operation==='views')result=await client.views(job);
    if(job.operation==='publish')result=await client.publish({...job,execute});
  }finally{await provider?.close();}
  console.log(JSON.stringify(result,null,2));
}catch(e){console.error(JSON.stringify({error:e instanceof ThreadsError?e.code:'LOCAL_ERROR',...(e.detail&&typeof e.detail==='object'?{detail:e.detail}:{})}));process.exitCode=1;}
