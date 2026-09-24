import {readFile} from 'node:fs/promises';
import {XClient,XError,loadContracts} from './client.mjs';
import {openProvider} from './provider.mjs';
// stdin is for a JSON job only. Credentials come from the calling process environment.
let client,provider;
try{
  const chunks=[];let size=0;for await(const chunk of process.stdin){size+=chunk.length;if(size>16384)throw new XError('INPUT_SIZE');chunks.push(chunk);}
  const job=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(!['profile','timeline','detail','conversation','publish'].includes(job.operation))throw new XError('OPERATION_DENIED');
  provider=await openProvider({modulePath:process.env.X_SESSION_PROVIDER_MODULE});
  client=new XClient({...provider.credentials,transactionProvider:provider.transactionProvider,contracts:await loadContracts()});
  let result;
  if(job.operation==='profile')result=await client.profile(job.handle);
  if(job.operation==='timeline')result=await client.timeline(job.handle,job);
  if(job.operation==='detail')result=await client.detail(job.postId,job.handle);
  if(job.operation==='conversation')result=await client.conversation(job.postId);
  if(job.operation==='publish')result=await client.publish({...job,execute:process.argv.includes('--execute')});
  console.log(JSON.stringify({ok:true,result}));
}catch(e){console.error(JSON.stringify({ok:false,code:e instanceof XError?e.code:'INPUT_OR_LOCAL_ERROR',receipt:e instanceof XError?e.receipt:undefined}));process.exitCode=1;}
finally{client?.close();try{await provider?.close();}catch{process.stderr.write('{"ok":false,"code":"PROVIDER_CLOSE_FAILED"}\n');process.exitCode=1;}}
