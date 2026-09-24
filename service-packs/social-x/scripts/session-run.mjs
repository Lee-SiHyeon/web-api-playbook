// One-shot local browser-to-HTTP-process handoff. No credential files or logging.
import http from 'node:http';
import {writeFile,mkdir,readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {XClient,loadContracts,XError} from '../src/client.mjs';
const job=JSON.parse(await readFile(process.argv[2],'utf8'));
if(!['timeline','publish','detail','conversation'].includes(job.operation))throw Error('JOB_INVALID');
const nonce=randomBytes(24).toString('hex');let consumed=false;let origin;
const server=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',"default-src 'none'; form-action 'self'; frame-ancestors 'none'");
  if(req.headers.host!==new URL(origin).host){res.writeHead(403).end();return;}
  if(req.method==='GET'&&req.url==='/'){
    res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<h1>X one-shot session handoff</h1><form method="post" action="/handoff"><input type="hidden" name="nonce" value="${nonce}"><label>Session envelope<input type="password" name="envelope" autocomplete="off"></label><button>Run authorized job</button></form>`);return;
  }
  if(req.method!=='POST'||req.url!=='/handoff'||req.headers.origin!==origin||consumed){res.writeHead(403).end();return;}
  let client;
  try{
    const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>32768)throw new XError('INPUT_SIZE');chunks.push(chunk);}
    const form=new URLSearchParams(Buffer.concat(chunks).toString());if(form.get('nonce')!==nonce)throw new XError('NONCE');
    consumed=true;const session=JSON.parse(form.get('envelope'));form.delete('envelope');chunks.length=0;
    const contracts=await loadContracts();const transactions=new Map();
    // Optional exact current read-request capture for one-shot diagnostic replay.
    for(const r of session.requests??[]){
      const u=new URL(r.url),name=u.pathname.split('/').at(-1);
      const write=name==='CreateTweet'&&r.method==='POST'&&job.operation==='publish';
      if(u.origin!=='https://x.com'||!write&&(r.method!=='GET'||!['UserByScreenName','UserOriginalsTimeline','TweetDetail'].includes(name))||!/^\/i\/api\/graphql\/[\w-]+\//.test(u.pathname))throw new XError('CAPTURE_SCOPE');
      if(write){
        const v=r.body?.variables;
        if(r.browserAborted!==true||v?.tweet_text!==job.text||JSON.stringify(v.media)!==JSON.stringify({media_entities:[],possibly_sensitive:false})||v.semantic_annotation_ids?.length!==0||v.disallowed_reply_options!==null||Object.keys(v).some(k=>!['tweet_text','media','semantic_annotation_ids','disallowed_reply_options','semantic_annotation_options'].includes(k)))throw new XError('CAPTURE_WRITE_MISMATCH');
        job.semanticAnnotationOptions=v.semantic_annotation_options;
      }
      contracts.operations[name]={queryId:u.pathname.split('/').at(-2),features:write?r.body.features:JSON.parse(u.searchParams.get('features')??'{}'),fieldToggles:write?r.body.fieldToggles??{}:JSON.parse(u.searchParams.get('fieldToggles')??'{}')};
      transactions.set(u.pathname,r.transactionId);
    }
    client=new XClient({...session,contracts,transactionProvider:transactions.size?async({path})=>{const token=transactions.get(path);transactions.delete(path);if(!token)throw new XError('CAPTURE_CONSUMED');return token;}:undefined});
    for(const key of Object.keys(session))delete session[key];
    const result=job.operation==='timeline'?await client.timeline(job.handle,job):job.operation==='detail'?await client.detail(job.postId,job.handle):job.operation==='conversation'?await client.conversation(job.postId):await client.publish({...job,execute:true});
    await mkdir('runtime',{recursive:true});await writeFile('runtime/latest-result.json',JSON.stringify({ok:true,result},null,2));
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,result}));
  }catch(e){const failure={ok:false,code:e instanceof XError?e.code:'HANDOFF_FAILURE',receipt:e instanceof XError?e.receipt:undefined};await mkdir('runtime',{recursive:true});await writeFile('runtime/latest-result.json',JSON.stringify(failure));res.setHeader('Content-Type','application/json');res.end(JSON.stringify(failure));}
  finally{client?.close();server.close();server.closeIdleConnections();clearTimeout(deadline);}
});
const deadline=setTimeout(()=>{server.close();process.exit(2);},180000);
server.listen(0,'127.0.0.1',()=>{origin=`http://127.0.0.1:${server.address().port}`;console.log(origin);});
